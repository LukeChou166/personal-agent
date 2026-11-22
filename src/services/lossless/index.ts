/**
 * 无损上下文模式 —— 对外门面。
 *
 * 批次 1 交付设置解析与命令入口；批次 2 接上本地存储与消息捕获。
 * 摘要、检索与护栏仍在后续批次。
 */

export {
  getLosslessConfig,
  isLosslessEnabled,
  resetLosslessConfigCacheForTesting,
  setSessionOverride,
} from './settings.js'
export type { LosslessConfig, LosslessSource } from './settings.js'
export type { LosslessStats } from './stats.js'

import type { LosslessStats } from './stats.js'

/** 供 `/lossless status` 使用的只读快照（懒加载，避免测试引入 bootstrap）。 */
export function getLosslessStats(): LosslessStats {
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { readCurrentStats } =
      require('./stats.js') as typeof import('./stats.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    return readCurrentStats()
  } catch {
    return {
      recordsAvailable: false,
      messages: 0,
      nodes: 0,
      pendingMessages: 0,
      pendingNodes: 0,
      failures: 0,
      tripped: false,
      callsInWindow: 0,
    }
  }
}
