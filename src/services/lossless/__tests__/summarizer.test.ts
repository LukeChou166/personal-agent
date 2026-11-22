import { afterAll, describe, expect, mock, test } from 'bun:test'

let behavior: 'ok' | 'throw' | 'empty' = 'ok'

mock.module('src/utils/sideQuery.js', () => ({
  sideQuery: async () => {
    if (behavior === 'throw') throw new Error('timeout')
    if (behavior === 'empty') return { content: [] }
    return {
      content: [
        { type: 'text', text: '  摘要正文  ' },
        { type: 'text', text: '第二段' },
      ],
    }
  },
}))

const { createSummarizer } = await import('src/services/lossless/summarizer.js')

afterAll(() => mock.restore())

describe('lossless summarizer', () => {
  test('拼接文本块并去除首尾空白', async () => {
    behavior = 'ok'
    const summarize = createSummarizer({ model: 'm', timeoutMs: 1000 })
    expect(await summarize({ text: '原文', targetTokens: 64 })).toBe(
      '摘要正文  \n第二段',
    )
  })

  test('模型抛错时返回 null，不向调用方抛出', async () => {
    behavior = 'throw'
    const summarize = createSummarizer({ model: 'm', timeoutMs: 1000 })
    expect(await summarize({ text: '原文', targetTokens: 64 })).toBeNull()
  })

  test('空输出视为失败', async () => {
    behavior = 'empty'
    const summarize = createSummarizer({ model: 'm', timeoutMs: 1000 })
    expect(await summarize({ text: '原文', targetTokens: 64 })).toBeNull()
  })
})
