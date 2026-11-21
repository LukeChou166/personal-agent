import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createStore,
  type MessageRecord,
  type SummaryNode,
} from 'src/services/lossless/store.js'

const roots: string[] = []

function tempStore() {
  const root = mkdtempSync(join(tmpdir(), 'lossless-store-'))
  roots.push(root)
  const store = createStore({
    storeRoot: root,
    projectKey: '-tmp-project',
    sessionId: 'session-1',
  })
  return { root, store }
}

function record(seq: number, uuid = `uuid-${seq}`): MessageRecord {
  return {
    v: 1,
    seq,
    uuid,
    ts: new Date(0).toISOString(),
    role: 'user',
    blocks: [{ type: 'text', text: `message ${seq}` }],
    tokenEstimate: 3,
    large: false,
  }
}

function node(id: string): SummaryNode {
  return {
    v: 1,
    id,
    sessionId: 'session-1',
    depth: 1,
    kind: 'leaf',
    childNodeIds: [],
    span: { firstSeq: 1, lastSeq: 2 },
    text: '摘要',
    tokenEstimate: 10,
    model: 'test-model',
    createdAt: new Date(0).toISOString(),
    status: 'active',
  }
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('lossless store', () => {
  test('追加后可按顺序读回消息与节点', () => {
    const { store } = tempStore()
    store.appendMessage(record(1))
    store.appendMessage(record(2))
    store.appendNode(node('n1'))

    const messages = store.readMessages()
    expect(messages.records.map(r => r.seq)).toEqual([1, 2])
    expect(messages.corruptLines).toBe(0)
    expect(store.readNodes().nodes[0]?.id).toBe('n1')
  })

  test('坏行被跳过并计数，不影响其他记录', () => {
    const { store } = tempStore()
    store.appendMessage(record(1))
    writeFileSync(store.paths.messages, '{"broken": \n', { flag: 'a' })
    store.appendMessage(record(2))

    const result = store.readMessages()
    expect(result.records.map(r => r.uuid)).toEqual(['uuid-1', 'uuid-2'])
    expect(result.corruptLines).toBe(1)
  })

  test('meta 原子写入可读回，缺失与损坏时返回 null', () => {
    const { store } = tempStore()
    expect(store.readMeta()).toBeNull()

    store.writeMeta({
      schemaVersion: 1,
      sessionId: 'session-1',
      projectKey: '-tmp-project',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      lastSeq: 2,
      lastUuid: 'uuid-2',
      messageCount: 2,
      nodeCount: 0,
      corruptLines: 0,
    })
    expect(store.readMeta()?.lastSeq).toBe(2)
    expect(store.nextSeq()).toBe(3)

    writeFileSync(store.paths.meta, '{')
    expect(store.readMeta()).toBeNull()
  })

  test('目录与文件权限收紧到 0700 / 0600', () => {
    if (process.platform === 'win32') return
    const { store } = tempStore()
    store.appendMessage(record(1))
    store.writeMeta({
      schemaVersion: 1,
      sessionId: 'session-1',
      projectKey: '-tmp-project',
      createdAt: '',
      updatedAt: '',
      lastSeq: 1,
      messageCount: 1,
      nodeCount: 0,
      corruptLines: 0,
    })

    expect(statSync(store.paths.dir).mode & 0o777).toBe(0o700)
    expect(statSync(store.paths.messages).mode & 0o777).toBe(0o600)
    expect(statSync(store.paths.meta).mode & 0o777).toBe(0o600)
  })

  test('knownUuids 去重集合与空目录行为', () => {
    const { store } = tempStore()
    expect(store.knownUuids().size).toBe(0)
    store.appendMessage(record(1, 'same'))
    store.appendMessage(record(2, 'same'))
    expect(store.knownUuids()).toEqual(new Set(['same']))
  })
})
