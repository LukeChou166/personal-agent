import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  describeNode,
  expandNode,
  grepHistory,
} from 'src/services/lossless/retrieval.js'
import {
  createStore,
  type MessageRecord,
  type SummaryNode,
} from 'src/services/lossless/store.js'

const roots: string[] = []

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'lossless-retrieval-'))
  roots.push(root)
  const store = createStore({
    storeRoot: root,
    projectKey: 'p',
    sessionId: 's',
  })
  const texts = [
    'alpha 第一条',
    'beta 第二条 包含 needle',
    'gamma 第三条',
    'delta 第四条',
  ]
  texts.forEach((text, index) => {
    const record: MessageRecord = {
      v: 1,
      seq: index + 1,
      uuid: `uuid-${index + 1}`,
      ts: new Date(0).toISOString(),
      role: index % 2 === 0 ? 'user' : 'assistant',
      blocks: [{ type: 'text', text }],
      tokenEstimate: index === 3 ? 500 : 5,
      large: false,
    }
    store.appendMessage(record)
  })
  const node: SummaryNode = {
    v: 1,
    id: 'n1',
    sessionId: 's',
    depth: 1,
    kind: 'leaf',
    childNodeIds: [],
    span: { firstSeq: 1, lastSeq: 3 },
    text: '前三条的摘要',
    tokenEstimate: 10,
    model: 'm',
    createdAt: new Date(0).toISOString(),
    status: 'active',
  }
  store.appendNode(node)
  return store
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('lossless retrieval', () => {
  test('按关键词检索并标注覆盖节点的 id', () => {
    const store = setup()
    const { hits, scanned } = grepHistory(store, { pattern: 'NEEDLE' })
    expect(scanned).toBeGreaterThan(0)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.seq).toBe(2)
    expect(hits[0]?.snippet).toContain('needle')
    expect(hits[0]?.nodeId).toBe('n1')
  })

  test('角色与节点范围过滤生效', () => {
    const store = setup()
    expect(
      grepHistory(store, { pattern: '第', role: 'user' }).hits.map(h => h.seq),
    ).toEqual([1, 3])
    expect(
      grepHistory(store, { pattern: 'delta', nodeId: 'n1' }).hits,
    ).toHaveLength(0)
  })

  test('describe 返回节点与可展开规模，未知节点返回 null', () => {
    const store = setup()
    const described = describeNode(store, 'n1')
    expect(described?.node.text).toBe('前三条的摘要')
    expect(described?.expandable_tokens).toBe(15)
    expect(describeNode(store, 'missing')).toBeNull()
  })

  test('expand 按 seq 拼接并在超限时给出续读游标', () => {
    const store = setup()
    const full = expandNode(store, { nodeId: 'n1' })
    expect(full.messages).toBe(3)
    expect(full.text).toContain('[1/uuid-1/user]')
    expect(full.truncated).toBe(false)

    const small = expandNode(store, { nodeId: 'n1', maxTokens: 200 })
    expect(small.truncated).toBe(false)

    const limited = expandNode(store, {
      messageIds: ['uuid-1', 'uuid-2', 'uuid-3', 'uuid-4'],
      maxTokens: 200,
    })
    expect(limited.truncated).toBe(true)
    expect(limited.next?.startSeq).toBe(4)
  })
})
