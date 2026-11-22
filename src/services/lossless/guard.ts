/**
 * 摘要花费护栏：滑动窗口计数 + 触发后的冷却期。
 *
 * 只做纯函数计算，状态由调用方持久化到 `meta.json` 的 `guard` 字段，
 * 便于测试与状态命令读取。
 */

import type { GuardState } from './store.js'

export type GuardConfig = {
  windowMs: number
  maxCallsPerWindow: number
  backoffMs: number
}

export type GuardDecision = {
  allowed: boolean
  reason?: 'window' | 'backoff'
}

export function evaluateGuard(
  state: GuardState | undefined,
  config: GuardConfig,
  now = Date.now(),
): GuardDecision {
  if (state?.backoffUntil && now < state.backoffUntil) {
    return { allowed: false, reason: 'backoff' }
  }
  if (config.maxCallsPerWindow <= 0) return { allowed: true }

  const windowExpired = !state || now - state.windowStart >= config.windowMs
  const calls = windowExpired ? 0 : state.callsInWindow
  if (calls >= config.maxCallsPerWindow) {
    return { allowed: false, reason: 'window' }
  }
  return { allowed: true }
}

export function recordGuardCall(
  state: GuardState | undefined,
  config: GuardConfig,
  now = Date.now(),
): GuardState {
  const windowExpired = !state || now - state.windowStart >= config.windowMs
  return {
    windowStart: windowExpired ? now : state!.windowStart,
    callsInWindow: (windowExpired ? 0 : state!.callsInWindow) + 1,
    backoffUntil: state?.backoffUntil,
    lastCallAt: now,
  }
}

export function recordGuardFailure(
  state: GuardState | undefined,
  config: GuardConfig,
  now = Date.now(),
): GuardState {
  const base = state ?? { windowStart: now, callsInWindow: 0 }
  return { ...base, backoffUntil: now + config.backoffMs }
}
