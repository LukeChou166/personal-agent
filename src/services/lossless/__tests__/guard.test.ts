import { describe, expect, test } from 'bun:test'
import {
  evaluateGuard,
  recordGuardCall,
  recordGuardFailure,
} from 'src/services/lossless/guard.js'

const config = { windowMs: 1000, maxCallsPerWindow: 2, backoffMs: 5000 }

describe('lossless guard', () => {
  test('窗口内达到上限后拒绝调用', () => {
    const state = { windowStart: 0, callsInWindow: 2 }
    expect(evaluateGuard(state, config, 500)).toEqual({
      allowed: false,
      reason: 'window',
    })
    expect(evaluateGuard(state, config, 1500).allowed).toBe(true)
  })

  test('冷却期内拒绝调用，过期后恢复', () => {
    const state = { windowStart: 0, callsInWindow: 0, backoffUntil: 5000 }
    expect(evaluateGuard(state, config, 4000)).toEqual({
      allowed: false,
      reason: 'backoff',
    })
    expect(evaluateGuard(state, config, 6000).allowed).toBe(true)
  })

  test('记录调用会滚动窗口并累加计数', () => {
    const next = recordGuardCall(
      { windowStart: 0, callsInWindow: 1 },
      config,
      500,
    )
    expect(next).toEqual({
      windowStart: 0,
      callsInWindow: 2,
      backoffUntil: undefined,
      lastCallAt: 500,
    })
    const rolled = recordGuardCall(next, config, 2000)
    expect(rolled.callsInWindow).toBe(1)
    expect(rolled.windowStart).toBe(2000)
  })

  test('失败写入冷却截止时间', () => {
    const next = recordGuardFailure(
      { windowStart: 0, callsInWindow: 1 },
      config,
      1000,
    )
    expect(next.backoffUntil).toBe(6000)
  })
})
