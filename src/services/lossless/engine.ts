/**
 * 分层摘要引擎：把「受保护的新鲜尾巴」之外的消息压成叶子摘要，
 * 再把同层摘要按扇出压成更高层摘要。
 *
 * 只依赖存储句柄与一个注入的摘要函数，方便测试替换模型调用；
 * 本轮不做上下文装配（属于下一批次），因此对用户不可见。
 */

import { randomUUID } from 'node:crypto'
import type { SummarizeFn } from './summarizer.js'
import type {
  LosslessStore,
  MessageRecord,
  StoreMeta,
  SummaryNode,
} from './store.js'

export type EngineConfig = {
  /** 受保护、不参与摘要的近期消息条数。 */
  freshTailCount: number
  /** 单个叶子分块的最大源 token。 */
  leafChunkTokens: number
  /** 叶子摘要最少覆盖的消息条数。 */
  leafMinFanout: number
  /** 叶子摘要目标 token。 */
  leafTargetTokens: number
  /** 浓缩摘要最少子节点数。 */
  condensedMinFanout: number
  /** 浓缩摘要目标 token。 */
  condensedTargetTokens: number
  /** 每轮允许新增的浓缩层数：0 仅叶子，-1 不限。 */
  incrementalMaxDepth: number
}

export type EngineSession = { sessionId: string; projectKey: string }

export type EngineOutcome = {
  leavesCreated: number
  condensedCreated: number
  pendingMessages: number
  failures: number
  tripped: boolean
}

const MAX_CONSECUTIVE_FAILURES = 3

function recordText(record: MessageRecord): string {
  const parts: string[] = []
  for (const block of record.blocks) {
    if (typeof block.text === 'string') {
      parts.push(block.text)
      continue
    }
    if (block.type === 'tool_use') {
      parts.push(
        `[tool ${String(block.name ?? '')}] ${JSON.stringify(block.input ?? {})}`,
      )
      continue
    }
    if (block.type === 'tool_result') {
      const content = block.content
      parts.push(
        typeof content === 'string' ? content : JSON.stringify(content ?? ''),
      )
      continue
    }
    if (block.type === 'image') parts.push('[image]')
  }
  return parts.join('\n')
}

/** 按 token 预算与最小扇出切分叶子块；不足扇出的尾部留作待压缩。 */
function planChunks(
  records: MessageRecord[],
  config: EngineConfig,
): MessageRecord[][] {
  const plans: MessageRecord[][] = []
  let chunk: MessageRecord[] = []
  let tokens = 0
  for (const record of records) {
    chunk.push(record)
    tokens += record.tokenEstimate
    if (
      tokens >= config.leafChunkTokens &&
      chunk.length >= config.leafMinFanout
    ) {
      plans.push(chunk)
      chunk = []
      tokens = 0
    }
  }
  return plans
}

function emptyMeta(session: EngineSession): StoreMeta {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    sessionId: session.sessionId,
    projectKey: session.projectKey,
    createdAt: now,
    updatedAt: now,
    lastSeq: 0,
    messageCount: 0,
    nodeCount: 0,
    corruptLines: 0,
  }
}

function makeNode(input: {
  sessionId: string
  depth: number
  kind: 'leaf' | 'condensed'
  childNodeIds: string[]
  span: { firstSeq: number; lastSeq: number }
  text: string
  model: string
  messageIds?: string[]
}): SummaryNode {
  return {
    v: 1,
    id: `n_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    sessionId: input.sessionId,
    depth: input.depth,
    kind: input.kind,
    childNodeIds: input.childNodeIds,
    span: input.span,
    messageIds: input.messageIds,
    text: input.text,
    tokenEstimate: Math.ceil(input.text.length / 4),
    model: input.model,
    createdAt: new Date().toISOString(),
    status: 'active',
  }
}

export function createEngine(deps: {
  store: LosslessStore
  config: EngineConfig
  summarize: SummarizeFn
  model: string
  session: EngineSession
}): { run(): Promise<EngineOutcome> } {
  const callSummary = async (text: string, targetTokens: number) => {
    try {
      return await deps.summarize({ text, targetTokens })
    } catch {
      return null
    }
  }

  return {
    async run(): Promise<EngineOutcome> {
      const { records } = deps.store.readMessages()
      const { nodes } = deps.store.readNodes()
      const meta = deps.store.readMeta()
      const backlog = meta?.backlog

      if (backlog?.tripped) {
        return {
          leavesCreated: 0,
          condensedCreated: 0,
          pendingMessages: backlog.pendingMessages,
          failures: backlog.failures,
          tripped: true,
        }
      }

      const coveredThrough = nodes.reduce(
        (max, node) => Math.max(max, node.span.lastSeq),
        0,
      )
      const tailStartIndex = Math.max(
        0,
        records.length - deps.config.freshTailCount,
      )
      const candidates = records
        .slice(0, tailStartIndex)
        .filter(record => record.seq > coveredThrough)

      let failures = 0
      const created: SummaryNode[] = []
      for (const plan of planChunks(candidates, deps.config)) {
        if (failures >= MAX_CONSECUTIVE_FAILURES) break
        const text = plan.map(recordText).filter(Boolean).join('\n---\n')
        const summary = await callSummary(text, deps.config.leafTargetTokens)
        if (!summary) {
          failures++
          continue
        }
        const node = makeNode({
          sessionId: deps.session.sessionId,
          depth: 1,
          kind: 'leaf',
          childNodeIds: [],
          span: {
            firstSeq: plan[0]!.seq,
            lastSeq: plan[plan.length - 1]!.seq,
          },
          text: summary,
          model: deps.model,
          messageIds: plan.map(record => record.uuid),
        })
        deps.store.appendNode(node)
        created.push(node)
      }

      const pool = [...nodes, ...created]
      const condensed: SummaryNode[] = []
      const maxDepth =
        deps.config.incrementalMaxDepth < 0
          ? Number.POSITIVE_INFINITY
          : 1 + deps.config.incrementalMaxDepth

      let depth = 1
      while (depth < maxDepth && failures < MAX_CONSECUTIVE_FAILURES) {
        const parented = new Set(
          pool
            .filter(node => node.depth === depth + 1)
            .flatMap(node => node.childNodeIds),
        )
        const layer = pool
          .filter(node => node.depth === depth && !parented.has(node.id))
          .sort((a, b) => a.span.firstSeq - b.span.firstSeq)
        if (layer.length < deps.config.condensedMinFanout) break

        let progressed = false
        for (
          let i = 0;
          i + deps.config.condensedMinFanout <= layer.length;
          i += deps.config.condensedMinFanout
        ) {
          const group = layer.slice(i, i + deps.config.condensedMinFanout)
          const text = group.map(node => node.text).join('\n---\n')
          const summary = await callSummary(
            text,
            deps.config.condensedTargetTokens,
          )
          if (!summary) {
            failures++
            break
          }
          const node = makeNode({
            sessionId: deps.session.sessionId,
            depth: depth + 1,
            kind: 'condensed',
            childNodeIds: group.map(child => child.id),
            span: {
              firstSeq: group[0]!.span.firstSeq,
              lastSeq: group[group.length - 1]!.span.lastSeq,
            },
            text: summary,
            model: deps.model,
          })
          deps.store.appendNode(node)
          condensed.push(node)
          pool.push(node)
          progressed = true
        }
        if (!progressed) break
        depth++
      }

      const coveredAfter = pool.reduce(
        (max, node) => Math.max(max, node.span.lastSeq),
        0,
      )
      const pendingMessages = records
        .slice(0, tailStartIndex)
        .filter(record => record.seq > coveredAfter).length
      const parentedAll = new Set(pool.flatMap(node => node.childNodeIds))
      const totalFailures =
        failures > 0 ? (backlog?.failures ?? 0) + failures : 0
      const tripped = totalFailures >= MAX_CONSECUTIVE_FAILURES

      const nextMeta: StoreMeta = {
        ...(meta ?? emptyMeta(deps.session)),
        updatedAt: new Date().toISOString(),
        nodeCount: pool.length,
        backlog: {
          pendingMessages,
          pendingNodes: pool.filter(node => !parentedAll.has(node.id)).length,
          failures: totalFailures,
          tripped,
          lastError: failures > 0 ? 'summary call failed' : undefined,
        },
      }
      deps.store.writeMeta(nextMeta)

      return {
        leavesCreated: created.length,
        condensedCreated: condensed.length,
        pendingMessages,
        failures: totalFailures,
        tripped,
      }
    },
  }
}
