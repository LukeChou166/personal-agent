import { describe, expect, test } from 'bun:test'
import { buildLosslessCompaction } from 'src/services/lossless/assembler.js'
import type { SummaryNode } from 'src/services/lossless/store.js'
import type { Message } from 'src/types/message.js'

function uuid(index: number): `00000000-0000-4000-8000-00000000000${number}` {
  return `00000000-0000-4000-8000-00000000000${index}`
}

function message(index: number): Message {
  return {
    type: 'user',
    uuid: uuid(index),
    message: { content: `消息 ${index}` },
  } as unknown as Message
}

function node(
  id: string,
  depth: number,
  first: number,
  last: number,
  text: string,
  children: string[] = [],
): SummaryNode {
  return {
    v: 1,
    id,
    sessionId: 's',
    depth,
    kind: depth === 1 ? 'leaf' : 'condensed',
    childNodeIds: children,
    span: { firstSeq: first, lastSeq: last },
    text,
    tokenEstimate: 10,
    model: 'm',
    createdAt: new Date(0).toISOString(),
    status: 'active',
  }
}

describe('lossless assembler', () => {
  test('只要有根摘要 + 新鲜尾巴，并跳过被父节点覆盖的摘要', () => {
    const result = buildLosslessCompaction({
      messages: [message(1), message(2), message(3), message(4)],
      nodes: [
        node('n1', 1, 1, 2, '叶子一'),
        node('n2', 1, 3, 4, '叶子二'),
        node('n3', 2, 1, 4, '根摘要', ['n1', 'n2']),
      ],
      freshTailCount: 2,
      trigger: 'auto',
      preCompactTokenCount: 100,
    })

    expect(result.boundaryMarker.type).toBe('system')
    expect(result.summaryMessages).toHaveLength(1)
    const content = String(result.summaryMessages[0]?.message?.content)
    expect(content).toContain('根摘要')
    expect(content).not.toContain('叶子一')
    expect(result.messagesToKeep?.map(m => m.uuid)).toEqual([uuid(3), uuid(4)])
  })

  test('没有摘要时不生成 summary 消息，但仍保留尾巴', () => {
    const result = buildLosslessCompaction({
      messages: [message(1), message(2)],
      nodes: [],
      freshTailCount: 1,
      trigger: 'manual',
      preCompactTokenCount: 10,
    })
    expect(result.summaryMessages).toHaveLength(0)
    expect(result.messagesToKeep).toHaveLength(1)
  })
})
