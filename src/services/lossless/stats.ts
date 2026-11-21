/**
 * 无损模式的状态快照，供 `/lossless status` 使用。
 *
 * 只读 `meta.json` 的计数，不扫描消息正文，保证状态命令在 200ms 内返回。
 */

import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'
import { getLosslessConfig } from './settings.js'
import { createStore } from './store.js'

export type LosslessStats = {
  recordsAvailable: boolean
  messages: number
  nodes: number
  pendingMessages: number
  failures: number
  callsInWindow: number
}

export const EMPTY_STATS: LosslessStats = {
  recordsAvailable: false,
  messages: 0,
  nodes: 0,
  pendingMessages: 0,
  failures: 0,
  callsInWindow: 0,
}

export function readCurrentStats(): LosslessStats {
  const config = getLosslessConfig()
  if (!config.enabled) return EMPTY_STATS

  const store = createStore({
    storeRoot: config.storeRoot,
    projectKey: sanitizePath(getOriginalCwd()),
    sessionId: getSessionId(),
  })
  const meta = store.readMeta()
  if (!meta) return EMPTY_STATS

  return {
    recordsAvailable: true,
    messages: meta.messageCount,
    nodes: meta.nodeCount,
    pendingMessages: 0,
    failures: 0,
    callsInWindow: 0,
  }
}
