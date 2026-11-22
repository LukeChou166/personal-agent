/**
 * 历史回溯：按关键词检索、查看摘要节点、展开原文。
 *
 * 只读当前会话目录；跨会话引用一律视为不存在（返回空/未找到）。
 */

import type { LosslessStore, MessageRecord, SummaryNode } from './store.js'

export type RetrievalHit = {
  messageId: string
  seq: number
  ts: string
  role: string
  snippet: string
  nodeId?: string
  large: boolean
}

export type GrepInput = {
  pattern: string
  limit?: number
  role?: 'user' | 'assistant' | 'any'
  nodeId?: string
}

function recordText(record: MessageRecord): string {
  const parts: string[] = []
  for (const block of record.blocks) {
    if (typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'tool_use') {
      parts.push(
        `[tool ${String(block.name ?? '')}] ${JSON.stringify(block.input ?? {})}`,
      )
    } else if (block.type === 'tool_result') {
      const content = block.content
      parts.push(
        typeof content === 'string' ? content : JSON.stringify(content ?? ''),
      )
    }
  }
  return parts.join('\n')
}

function nodeForSeq(
  nodes: SummaryNode[],
  seq: number,
): SummaryNode | undefined {
  return nodes.find(
    node => seq >= node.span.firstSeq && seq <= node.span.lastSeq,
  )
}

export function grepHistory(
  store: LosslessStore,
  input: GrepInput,
): { hits: RetrievalHit[]; scanned: number } {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50)
  const needle = input.pattern.toLowerCase()
  const role = input.role ?? 'any'
  const { records } = store.readMessages()
  const { nodes } = store.readNodes()
  const scope = input.nodeId
    ? nodes.find(node => node.id === input.nodeId)
    : null

  const hits: RetrievalHit[] = []
  let scanned = 0
  for (const record of records) {
    if (role !== 'any' && record.role !== role) continue
    if (
      scope &&
      (record.seq < scope.span.firstSeq || record.seq > scope.span.lastSeq)
    ) {
      continue
    }
    scanned++
    const text = recordText(record)
    const index = text.toLowerCase().indexOf(needle)
    if (index === -1) continue
    const start = Math.max(0, index - 120)
    const end = Math.min(text.length, index + needle.length + 120)
    hits.push({
      messageId: record.uuid,
      seq: record.seq,
      ts: record.ts,
      role: record.role,
      snippet: text.slice(start, end),
      nodeId: nodeForSeq(nodes, record.seq)?.id,
      large: record.large,
    })
    if (hits.length >= limit) break
  }
  return { hits, scanned }
}

export function describeNode(store: LosslessStore, nodeId: string) {
  const { nodes } = store.readNodes()
  const { records } = store.readMessages()
  const node = nodes.find(item => item.id === nodeId)
  if (!node) return null

  const children = nodes
    .filter(item => node.childNodeIds.includes(item.id))
    .slice(0, 20)
    .map(item => ({ id: item.id, depth: item.depth, span: item.span }))
  const covered = records.filter(
    record =>
      record.seq >= node.span.firstSeq && record.seq <= node.span.lastSeq,
  )

  return {
    node: {
      id: node.id,
      depth: node.depth,
      kind: node.kind,
      span: node.span,
      token_estimate: node.tokenEstimate,
      model: node.model,
      created_at: node.createdAt,
      status: node.status,
      text: node.text,
    },
    children,
    expandable_tokens: covered.reduce(
      (sum, record) => sum + record.tokenEstimate,
      0,
    ),
  }
}

export function expandNode(
  store: LosslessStore,
  input: { nodeId?: string; messageIds?: string[]; maxTokens?: number },
): {
  text: string
  messages: number
  tokens: number
  truncated: boolean
  next?: { startSeq: number }
} {
  const maxTokens = Math.min(Math.max(input.maxTokens ?? 4000, 200), 8000)
  const { records } = store.readMessages()
  const { nodes } = store.readNodes()

  let selected: MessageRecord[]
  if (input.nodeId) {
    const node = nodes.find(item => item.id === input.nodeId)
    selected = node
      ? records.filter(
          record =>
            record.seq >= node.span.firstSeq && record.seq <= node.span.lastSeq,
        )
      : []
  } else if (input.messageIds?.length) {
    const wanted = new Set(input.messageIds)
    selected = records.filter(record => wanted.has(record.uuid))
  } else {
    selected = []
  }

  selected.sort((a, b) => a.seq - b.seq)
  const lines: string[] = []
  let tokens = 0
  let next: { startSeq: number } | undefined

  for (const record of selected) {
    if (tokens + record.tokenEstimate > maxTokens) {
      next = { startSeq: record.seq }
      break
    }
    lines.push(
      `[${record.seq}/${record.uuid}/${record.role}]\n${recordText(record)}`,
    )
    tokens += record.tokenEstimate
  }

  return {
    text: lines.join('\n\n'),
    messages: lines.length,
    tokens,
    truncated: Boolean(next),
    next,
  }
}
