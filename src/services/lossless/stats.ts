/**
 * 无损模式的状态快照，供 `/lossless status` 使用。
 *
 * 只读 `meta.json` 的计数，不扫描消息正文，保证状态命令在 200ms 内返回。
 */

import { getSessionStore } from './sessionStore.js'

export type LosslessStats = {
  recordsAvailable: boolean
  messages: number
  nodes: number
  pendingMessages: number
  pendingNodes: number
  failures: number
  tripped: boolean
  callsInWindow: number
  backoffUntil?: number
}

export const EMPTY_STATS: LosslessStats = {
  recordsAvailable: false,
  messages: 0,
  nodes: 0,
  pendingMessages: 0,
  pendingNodes: 0,
  failures: 0,
  tripped: false,
  callsInWindow: 0,
}

export function readCurrentStats(): LosslessStats {
  const { store, config } = getSessionStore()
  if (!config.enabled) return EMPTY_STATS

  const meta = store.readMeta()
  if (!meta) return EMPTY_STATS

  return {
    recordsAvailable: true,
    messages: meta.messageCount,
    nodes: meta.nodeCount,
    pendingMessages: meta.backlog?.pendingMessages ?? 0,
    pendingNodes: meta.backlog?.pendingNodes ?? 0,
    failures: meta.backlog?.failures ?? 0,
    tripped: meta.backlog?.tripped ?? false,
    callsInWindow: meta.guard?.callsInWindow ?? 0,
    backoffUntil: meta.guard?.backoffUntil,
  }
}
