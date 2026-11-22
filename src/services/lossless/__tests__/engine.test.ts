import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createEngine,
  type EngineConfig,
} from 'src/services/lossless/engine.js'
import type { SummarizeFn } from 'src/services/lossless/summarizer.js'
import { createStore, type MessageRecord } from 'src/services/lossless/store.js'

const roots: string[] = []

function setup(
  configOverride: Partial<EngineConfig> = {},
  summarize?: SummarizeFn,
) {
  const root = mkdtempSync(join(tmpdir(), 'lossless-engine-'))
  roots.push(root)
  const store = createStore({
    storeRoot: root,
    projectKey: 'project',
    sessionId: 'session-1',
  })
  const config: EngineConfig = {
    freshTailCount: 0,
    leafChunkTokens: 10,
    leafMinFanout: 2,
    leafTargetTokens: 100,
    condensedMinFanout: 2,
    condensedTargetTokens: 80,
    incrementalMaxDepth: 1,
    ...configOverride,
  }
  const engine = createEngine({
    store,
    config,
    model: 'test-model',
    session: { sessionId: 'session-1', projectKey: 'project' },
    summarize: summarize ?? (async ({ text }) => `摘要(${text.length})`),
  })
  return { store, engine }
}

function seed(store: ReturnType<typeof createStore>, count: number) {
  for (let i = 1; i <= count; i++) {
    const record: MessageRecord = {
      v: 1,
      seq: i,
      uuid: `uuid-${i}`,
      ts: new Date(0).toISOString(),
      role: 'user',
      blocks: [{ type: 'text', text: `第 ${i} 条消息内容` }],
      tokenEstimate: 5,
      large: false,
    }
    store.appendMessage(record)
    store.writeMeta({
      schemaVersion: 1,
      sessionId: 'session-1',
      projectKey: 'project',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      lastSeq: i,
      messageCount: i,
      nodeCount: 0,
      corruptLines: 0,
    })
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('lossless engine', () => {
  test('按 token 预算与扇出生成叶子摘要，尾部留待压缩', async () => {
    const { store, engine } = setup()
    seed(store, 5)

    const outcome = await engine.run()
    expect(outcome.leavesCreated).toBe(2)
    expect(outcome.pendingMessages).toBe(1)

    const leaves = store.readNodes().nodes.filter(n => n.depth === 1)
    expect(leaves.map(n => n.span)).toEqual([
      { firstSeq: 1, lastSeq: 2 },
      { firstSeq: 3, lastSeq: 4 },
    ])
    expect(leaves[0]?.messageIds).toEqual(['uuid-1', 'uuid-2'])
    expect(leaves.every(n => n.kind === 'leaf')).toBe(true)
  })

  test('新鲜尾巴受 freshTailCount 保护，不进入摘要', async () => {
    const { store, engine } = setup({ freshTailCount: 2 })
    seed(store, 5)

    const outcome = await engine.run()
    expect(outcome.leavesCreated).toBe(1)
    expect(store.readNodes().nodes[0]?.span).toEqual({
      firstSeq: 1,
      lastSeq: 2,
    })
  })

  test('同层摘要满足扇出后生成浓缩节点', async () => {
    const { store, engine } = setup()
    seed(store, 8)

    const outcome = await engine.run()
    expect(outcome.leavesCreated).toBe(4)
    expect(outcome.condensedCreated).toBe(2)

    const nodes = store.readNodes().nodes
    expect(nodes.filter(n => n.depth === 2)).toHaveLength(2)
    expect(nodes.find(n => n.depth === 2)?.childNodeIds).toHaveLength(2)
    expect(nodes.find(n => n.depth === 2)?.span).toEqual({
      firstSeq: 1,
      lastSeq: 4,
    })
  })

  test('摘要持续失败时累计失败并熔断', async () => {
    const { store, engine } = setup({}, async () => null)
    seed(store, 8)

    const outcome = await engine.run()
    expect(outcome.leavesCreated).toBe(0)
    expect(outcome.failures).toBe(3)
    expect(outcome.tripped).toBe(true)
    expect(store.readMeta()?.backlog?.tripped).toBe(true)

    const second = await engine.run()
    expect(second.leavesCreated).toBe(0)
  })

  test('重复运行不会重复摘要已覆盖的消息', async () => {
    const { store, engine } = setup()
    seed(store, 4)

    expect((await engine.run()).leavesCreated).toBe(2)
    const second = await engine.run()
    expect(second.leavesCreated).toBe(0)
    expect(store.readNodes().nodes.filter(n => n.depth === 1)).toHaveLength(2)
  })
})
