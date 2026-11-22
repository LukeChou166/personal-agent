import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from 'src/types/message.js'
import { debugMock } from '../../../../tests/mocks/debug.js'

// 只 mock 有副作用的模块：调试日志、设置读取与 bootstrap 全局状态。
mock.module('src/utils/debug.ts', debugMock)
mock.module('src/utils/settings/settings.js', () => ({
  getInitialSettings: () => ({}),
  getSettingsWithSources: () => ({ effective: {}, sources: [] }),
  updateSettingsForSource: () => ({ error: null }),
}))
// bootstrap 有大量导出，只覆盖本次用到的两个，其余透传。
const realBootstrap = await import('src/bootstrap/state.js')
mock.module('src/bootstrap/state.js', () => ({
  ...realBootstrap,
  getOriginalCwd: () => '/tmp/lossless-capture-project',
  getSessionId: () => 'session-1',
}))

const { createCapture, matchesSessionPattern } = await import(
  'src/services/lossless/capture.js'
)
const { createStore } = await import('src/services/lossless/store.js')

const roots: string[] = []

function setup(overrides: Partial<Parameters<typeof createCapture>[1]> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lossless-capture-'))
  roots.push(root)
  const store = createStore({
    storeRoot: root,
    projectKey: 'project',
    sessionId: 'session-1',
  })
  const config = {
    largeFileTokenThreshold: 100,
    ignoreSessionPatterns: [],
    statelessSessionPatterns: [],
    ...overrides,
  }
  const capture = createCapture(store, config, {
    sessionId: 'session-1',
    projectKey: 'project',
  })
  return { store, capture }
}

function userMessage(uuid: string, text: string): Message {
  return {
    type: 'user',
    uuid,
    message: { content: text },
  } as unknown as Message
}

afterAll(() => mock.restore())

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('lossless capture', () => {
  test('逐轮追加新消息，重复 uuid 只写一次', () => {
    const { store, capture } = setup()
    expect(capture([userMessage('a', 'hi'), userMessage('b', 'there')])).toBe(2)
    expect(
      capture([userMessage('b', 'there'), userMessage('c', 'again')]),
    ).toBe(1)

    const { records } = store.readMessages()
    expect(records.map(r => r.uuid)).toEqual(['a', 'b', 'c'])
    expect(records.map(r => r.seq)).toEqual([1, 2, 3])
    expect(store.readMeta()?.messageCount).toBe(3)
  })

  test('大块内容按阈值标记 large', () => {
    const { store, capture } = setup({ largeFileTokenThreshold: 5 })
    capture([userMessage('big', 'x'.repeat(400))])
    expect(store.readMessages().records[0]?.large).toBe(true)
  })

  test('ignore 与 stateless 模式都不写入', () => {
    const ignored = setup({ ignoreSessionPatterns: ['session-*'] })
    expect(ignored.capture([userMessage('a', 'hi')])).toBe(0)
    expect(ignored.store.readMessages().records).toHaveLength(0)

    const stateless = setup({ statelessSessionPatterns: ['session-1'] })
    expect(stateless.capture([userMessage('a', 'hi')])).toBe(0)
    expect(stateless.store.readMessages().records).toHaveLength(0)
  })

  test('重启后继续捕获不重复、序号延续', () => {
    const first = setup()
    first.capture([userMessage('a', 'one')])

    const resumed = createCapture(
      first.store,
      {
        largeFileTokenThreshold: 100,
        ignoreSessionPatterns: [],
        statelessSessionPatterns: [],
      },
      { sessionId: 'session-1', projectKey: 'project' },
    )
    expect(resumed([userMessage('a', 'one'), userMessage('b', 'two')])).toBe(1)

    const { records } = first.store.readMessages()
    expect(records.map(r => r.uuid)).toEqual(['a', 'b'])
    expect(records[1]?.seq).toBe(2)
  })

  test('pattern 语法：* 不跨冒号，** 跨冒号', () => {
    expect(matchesSessionPattern('agent:*', 'agent:main')).toBe(true)
    expect(matchesSessionPattern('agent:*', 'agent:main:sub')).toBe(false)
    expect(matchesSessionPattern('agent:**', 'agent:main:sub')).toBe(true)
    expect(matchesSessionPattern('session-1', 'session-1')).toBe(true)
  })
})
