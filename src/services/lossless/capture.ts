/**
 * 消息捕获：把每轮新增消息追加到本地会话档案。
 *
 * 通过 post-sampling 钩子调用，同一 uuid 只写一次；压缩后仍在内存里的
 * 旧消息会被去重跳过，因此「留存」与「模型上下文」互不影响。
 * 关闭开关时首行即返回，不产生任何 I/O。
 */

import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  type REPLHookContext,
  registerPostSamplingHook,
} from '../../utils/hooks/postSamplingHooks.js'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'
import { getLosslessConfig, isLosslessEnabled } from './settings.js'
import {
  createStore,
  type LosslessStore,
  type MessageRecord,
  type StoreMeta,
} from './store.js'

type CaptureConfig = {
  largeFileTokenThreshold: number
  ignoreSessionPatterns: string[]
  statelessSessionPatterns: string[]
}

type SessionRef = { sessionId: string; projectKey: string }

/** 把 `*`（不跨冒号）与 `**`（跨冒号）转成正则，用于会话排除匹配。 */
export function matchesSessionPattern(pattern: string, key: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  // 先按 ** 拆分，再把单 * 展开为「不跨冒号」，避免引入控制字符占位。
  const source = escaped
    .split('**')
    .map(part => part.replace(/\*/g, '[^:]*'))
    .join('.*')
  return new RegExp(`^${source}$`).test(key)
}

function toBlocks(message: Message): Record<string, unknown>[] {
  const content = message.message?.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (Array.isArray(content)) {
    return content as unknown as Record<string, unknown>[]
  }
  return []
}

function findToolRef(blocks: Record<string, unknown>[]): {
  id?: string
  name?: string
} {
  for (const block of blocks) {
    if (block.type === 'tool_use' && typeof block.id === 'string') {
      return { id: block.id, name: String(block.name ?? '') }
    }
    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      return { id: block.tool_use_id }
    }
  }
  return {}
}

function buildRecord(
  message: Message,
  seq: number,
  config: CaptureConfig,
): MessageRecord {
  const blocks = toBlocks(message)
  const tokenEstimate = Math.ceil(JSON.stringify(blocks).length / 4)
  const tool = findToolRef(blocks)
  const record: MessageRecord = {
    v: 1,
    seq,
    uuid: String(message.uuid),
    ts: new Date().toISOString(),
    role: String(message.type),
    blocks,
    tokenEstimate,
    large: tokenEstimate > config.largeFileTokenThreshold,
  }
  if (tool.id) record.toolUseId = tool.id
  if (tool.name) record.toolName = tool.name
  return record
}

/** 创建一个会话的捕获器；返回值是「本轮新增条数」。 */
export function createCapture(
  store: LosslessStore,
  config: CaptureConfig,
  session: SessionRef,
): (messages: Message[]) => number {
  let seen: Set<string> | null = null
  let meta: StoreMeta | null = null
  let nextSeq = 1

  const init = (): void => {
    const { records, corruptLines } = store.readMessages()
    const stored = store.readMeta()
    seen = new Set(records.map(record => record.uuid))
    const maxStoredSeq = records.reduce((max, r) => Math.max(max, r.seq), 0)
    const now = new Date().toISOString()
    meta = stored ?? {
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
    meta.corruptLines = corruptLines
    nextSeq = Math.max(meta.lastSeq, maxStoredSeq) + 1
  }

  return (messages: Message[]): number => {
    const key = session.sessionId
    if (config.ignoreSessionPatterns.some(p => matchesSessionPattern(p, key))) {
      return 0
    }
    if (
      config.statelessSessionPatterns.some(p => matchesSessionPattern(p, key))
    ) {
      return 0
    }
    if (!seen || !meta) init()

    let added = 0
    for (const message of messages) {
      const uuid = String(message.uuid)
      if (seen!.has(uuid)) continue
      store.appendMessage(buildRecord(message, nextSeq, config))
      seen!.add(uuid)
      nextSeq++
      added++
    }
    if (added > 0 && meta) {
      meta.lastSeq = nextSeq - 1
      meta.messageCount += added
      meta.updatedAt = new Date().toISOString()
      store.writeMeta(meta)
    }
    return added
  }
}

const capturers = new Map<string, (messages: Message[]) => number>()
let registered = false

/** 在 setup 阶段调用一次；钩子内实时判断开关，支持会话中途开启。 */
export function registerLosslessCapture(): void {
  if (registered) return
  registered = true

  registerPostSamplingHook((context: REPLHookContext) => {
    if (!isLosslessEnabled()) return
    try {
      const config = getLosslessConfig()
      const sessionId = getSessionId()
      let capture = capturers.get(sessionId)
      if (!capture) {
        const projectKey = sanitizePath(getOriginalCwd())
        const store = createStore({
          storeRoot: config.storeRoot,
          projectKey,
          sessionId,
        })
        capture = createCapture(store, config, { sessionId, projectKey })
        capturers.set(sessionId, capture)
      }
      capture(context.messages)
    } catch (error) {
      logForDebugging(`lossless capture failed: ${String(error)}`, {
        level: 'warn',
      })
    }
  })
}
