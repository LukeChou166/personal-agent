/**
 * 无损上下文模式 —— 对外门面。
 *
 * 批次 1（PR-1）只交付设置解析与命令入口；存储、捕获、摘要与检索在后续
 * 批次落地。存储就绪前，`getLosslessStats` 固定返回 `recordsAvailable: false`。
 */

export {
  getLosslessConfig,
  isLosslessEnabled,
  resetLosslessConfigCacheForTesting,
  setSessionOverride,
} from './settings.js'
export type { LosslessConfig, LosslessSource } from './settings.js'

export type LosslessStats = {
  recordsAvailable: boolean
  messages: number
  nodes: number
  pendingMessages: number
  failures: number
  callsInWindow: number
}

/** 供 `/lossless status` 使用的只读快照（不做全量会话扫描）。 */
export function getLosslessStats(): LosslessStats {
  return {
    recordsAvailable: false,
    messages: 0,
    nodes: 0,
    pendingMessages: 0,
    failures: 0,
    callsInWindow: 0,
  }
}
