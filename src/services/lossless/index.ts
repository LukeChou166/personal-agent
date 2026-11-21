/**
 * Lossless context mode — public facade.
 *
 * Batch 1 (PR-1) ships settings resolution and the command surface. Store,
 * capture, summarisation and retrieval land in later batches; `getLosslessStats`
 * reports `recordsAvailable: false` until the store exists.
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

/** Read-only snapshot for `/lossless status` (no full transcript scan). */
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
