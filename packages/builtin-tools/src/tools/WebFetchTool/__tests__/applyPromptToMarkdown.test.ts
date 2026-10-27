import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { setupAxiosMock } from '../../../../../../tests/mocks/axios'
import { logMock } from '../../../../../../tests/mocks/log'

/**
 * Unit tests for the WebFetch secondary-model step — the place where
 * "No response from model" is produced (utils.ts:592).
 *
 * Convention per AGENTS.md "Mock 使用规范": mock only the lower layers
 * (axios / settings / log / analytics / http / binary storage) — never the
 * subject under test. Each mocked module spreads the real one so the
 * transitive imports of src/Tool.js keep working.
 */

// ── Controllable lower layers ───────────────────────────────────────────────

let haikuContent: unknown[] = []
let haikuShouldThrow: Error | null = null
let lastHaikuPrompt = ''

let tavilyRawContent = '# tweet\n\nhello world'
let tavilyShouldThrow: Error | null = null

const axiosHandle = setupAxiosMock()
axiosHandle.stubs.post = async () => {
  if (tavilyShouldThrow) throw tavilyShouldThrow
  return {
    data: { url: 'https://x.test/1', raw_content: tavilyRawContent },
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
  }
}

// utils.ts is the only importer of claude.js in this chain (queryHaiku).
mock.module('src/services/api/claude.js', () => ({
  queryHaiku: async ({ userPrompt }: { userPrompt: string }) => {
    lastHaikuPrompt = userPrompt
    if (haikuShouldThrow) throw haikuShouldThrow
    return { message: { content: haikuContent } }
  },
}))

// ── Narrow mocks for the WebFetchTool.ts import surface ─────────────────────
//
// WebFetchTool.ts pulls in src/Tool.js → permissions → … a very wide tree whose
// transitive imports need the whole settings surface. Sibling test files in this
// directory register narrower process-global mocks (mock.module is global in
// Bun), so instead of depending on the real modules we mock the three direct
// neighbours and keep the subject itself real.
mock.module('src/Tool.js', () => ({
  buildTool: (def: Record<string, unknown>) => ({ ...def }),
}))

mock.module('src/utils/permissions/permissions.js', () => ({
  getRuleByContentsForTool: () => new Map(),
}))

mock.module(new URL('../UI.tsx', import.meta.url).pathname, () => ({
  getToolUseSummary: () => null,
  renderToolUseMessage: () => null,
  renderToolUseProgressMessage: () => null,
  renderToolResultMessage: () => null,
}))

mock.module('src/services/analytics/index.js', () => ({
  logEvent: () => {},
}))

mock.module('src/utils/http.js', () => ({
  getWebFetchUserAgent: () => 'TestAgent/1.0',
}))

mock.module('src/utils/log.ts', logMock)

mock.module('src/utils/mcpOutputStorage.js', () => ({
  isBinaryContentType: (contentType: string) =>
    !contentType.toLowerCase().startsWith('text/'),
  persistBinaryContent: async () => ({
    filepath: '/tmp/webfetch-test.bin',
    size: 0,
  }),
}))

// Only getSettings_DEPRECATED / getInitialSettings are read by the subject.
mock.module('src/utils/settings/settings.js', () => ({
  getInitialSettings: () => ({}),
  getSettings_DEPRECATED: () => ({}),
}))

// import the subject EAGERLY, while the mocks above are the active ones:
// mock.module is process-global, and sibling test files in this directory
// register their own (narrower) settings/claude mocks. A lazy `await import`
// inside a test body would resolve against whichever mock was registered last.
const { WebFetchTool } = await import('../WebFetchTool')
const { applyPromptToMarkdown, clearWebFetchCache, MAX_MARKDOWN_LENGTH } =
  await import('../utils')

beforeAll(() => {
  axiosHandle.useStubs = true
})

afterAll(() => {
  axiosHandle.useStubs = false
})

beforeEach(() => {
  clearWebFetchCache()
  haikuContent = [{ type: 'text', text: 'SUMMARY' }]
  haikuShouldThrow = null
  lastHaikuPrompt = ''
  tavilyRawContent = '# tweet\n\nhello world'
  tavilyShouldThrow = null
})

/** Minimal ToolUseContext for WebFetchTool.call — only what call() reads. */
function callContext(abortController = new AbortController()) {
  return {
    abortController,
    options: { isNonInteractiveSession: true },
  } as never
}

// ── applyPromptToMarkdown ───────────────────────────────────────────────────

describe('applyPromptToMarkdown', () => {
  test('returns the text of the first text block', async () => {
    haikuContent = [{ type: 'text', text: '这是推文摘要' }]

    const result = await applyPromptToMarkdown(
      '总结这篇推文',
      '# tweet',
      new AbortController().signal,
      true,
      false,
    )

    expect(result).toBe('这是推文摘要')
  })

  test('falls back to "No response from model" when content is empty', async () => {
    haikuContent = []

    const result = await applyPromptToMarkdown(
      '总结这篇推文',
      '# tweet',
      new AbortController().signal,
      true,
      false,
    )

    expect(result).toBe('No response from model')
  })

  test('skips a leading thinking block and returns the real answer (qwen3.5-plus regression)', async () => {
    // qwen3.5-plus / deepseek / mimo 会先返回 thinking（或 reasoning）块，正文在
    // 后面的 text 块里。旧实现只看 content[0] → 回填 "No response from model"。
    haikuContent = [
      { type: 'thinking', thinking: 'reasoning…', signature: 'sig' },
      { type: 'text', text: '真正的答案' },
    ]

    const result = await applyPromptToMarkdown(
      '总结这篇推文',
      '# tweet',
      new AbortController().signal,
      true,
      false,
    )

    expect(result).toBe('真正的答案')
  })

  test('falls back when the model only produced a thinking block', async () => {
    haikuContent = [
      { type: 'thinking', thinking: 'reasoning…', signature: 'sig' },
    ]

    const result = await applyPromptToMarkdown(
      '总结这篇推文',
      '# tweet',
      new AbortController().signal,
      true,
      false,
    )

    expect(result).toBe('No response from model')
  })

  test('concatenates multiple text blocks', async () => {
    haikuContent = [
      { type: 'text', text: '第一段' },
      { type: 'text', text: '第二段' },
    ]

    const result = await applyPromptToMarkdown(
      '总结',
      '# tweet',
      new AbortController().signal,
      true,
      false,
    )

    expect(result).toBe('第一段第二段')
  })

  test('collects text appended to a mis-tagged thinking block (openai adapter bug)', async () => {
    // openai 兼容层的流适配器会把正文尾部的 text_delta 追加到已打开的 thinking
    // 块上：块是 type:'thinking'、thinking 为空、但带 text（qwen3.5-plus 实测）。
    // 按 type 过滤会把正文后半段丢掉，所以这里只按"是否有 text"收集。
    haikuContent = [
      { type: 'thinking', thinking: 'reasoning…', signature: '' },
      { type: 'text', text: '我是一个人工智能' },
      {
        type: 'thinking',
        thinking: '',
        signature: '',
        text: '助手，致力于提供帮助。',
      },
    ]

    const result = await applyPromptToMarkdown(
      '总结',
      '# tweet',
      new AbortController().signal,
      true,
      false,
    )

    expect(result).toBe('我是一个人工智能助手，致力于提供帮助。')
  })

  test('throws AbortError when the signal is aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      applyPromptToMarkdown(
        '总结这篇推文',
        '# tweet',
        controller.signal,
        true,
        false,
      ),
    ).rejects.toThrow()
  })

  test('truncates content longer than MAX_MARKDOWN_LENGTH before prompting', async () => {
    const longContent = 'a'.repeat(MAX_MARKDOWN_LENGTH + 1)

    await applyPromptToMarkdown(
      '总结',
      longContent,
      new AbortController().signal,
      true,
      false,
    )

    expect(lastHaikuPrompt).toContain('[Content truncated due to length...]')
    expect(lastHaikuPrompt).not.toContain(longContent)
  })

  test('propagates secondary model errors instead of swallowing them', async () => {
    haikuShouldThrow = new Error('secondary model 429')

    await expect(
      applyPromptToMarkdown(
        '总结',
        '# tweet',
        new AbortController().signal,
        true,
        false,
      ),
    ).rejects.toThrow('secondary model 429')
  })
})

// ── WebFetchTool.call (tavily backend) ──────────────────────────────────────

describe('WebFetchTool.call with tavily backend', () => {
  test('returns the secondary model summary when it produces text', async () => {
    haikuContent = [{ type: 'text', text: '推文摘要：XYZ' }]

    const { data } = await WebFetchTool.call(
      { url: 'https://x.com/addyosmani/status/1', prompt: '总结这篇推文' },
      callContext(),
    )

    expect(data.result).toBe('推文摘要：XYZ')
    expect(data.code).toBe(200)
    expect(data.url).toBe('https://x.com/addyosmani/status/1')
  })

  test('empty secondary model response becomes "No response from model" (not an error result)', async () => {
    haikuContent = []

    const { data } = await WebFetchTool.call(
      { url: 'https://x.com/addyosmani/status/2', prompt: '总结这篇推文' },
      callContext(),
    )

    expect(data.result).toBe('No response from model')

    // Reproduces the reported payload: a plain tool_result, no is_error.
    const block = WebFetchTool.mapToolResultToToolResultBlockParam(
      data,
      'call_046d1078b81248e8ba1f4ce7',
    )
    expect(block).toEqual({
      tool_use_id: 'call_046d1078b81248e8ba1f4ce7',
      type: 'tool_result',
      content: 'No response from model',
    })
    expect('is_error' in block).toBe(false)
  })

  test('empty prompt returns raw Tavily markdown without calling the secondary model', async () => {
    tavilyRawContent = '# raw markdown from tavily'

    const { data } = await WebFetchTool.call(
      { url: 'https://example.com/doc', prompt: '' },
      callContext(),
    )

    expect(data.result).toBe('# raw markdown from tavily')
    expect(lastHaikuPrompt).toBe('')
  })

  test('Tavily empty content throws so the tool_result is flagged is_error', async () => {
    tavilyRawContent = '   '

    await expect(
      WebFetchTool.call(
        { url: 'https://example.com/login-wall', prompt: '总结' },
        callContext(),
      ),
    ).rejects.toThrow(/Tavily Extract returned empty content/)
  })
})
