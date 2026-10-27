import { describe, expect, test } from 'bun:test'
import { resolveOpenAISmallFastModel } from '../model.js'

/**
 * 二级（小/快）模型取值链 —— WebFetch 的二级总结走 claude.ts:3523
 * (`model: getSmallFastModel()`)，这里是它 OpenAI 分支的纯逻辑。
 *
 * 只 import 纯函数：直接 import model.ts 会拉起 auth/settings/bootstrap 等
 * 重依赖链，在 bun test 里会被其他文件的进程级 mock 污染
 * （同 providers.test.ts 的做法）。
 */
describe('resolveOpenAISmallFastModel', () => {
  test('returns OPENAI_SMALL_FAST_MODEL when explicitly configured', () => {
    expect(
      resolveOpenAISmallFastModel({
        OPENAI_SMALL_FAST_MODEL: 'qwen3.5-plus',
        OPENAI_DEFAULT_HAIKU_MODEL: 'some-other-model',
      }),
    ).toBe('qwen3.5-plus')
  })

  test('falls back to OPENAI_DEFAULT_HAIKU_MODEL from settings.json env', () => {
    // ~/.claude/settings.json 的 env 由 applySafeConfigEnvironmentVariables()
    // 注入 process.env，当前配置值为 qwen3.5-plus
    expect(
      resolveOpenAISmallFastModel({
        OPENAI_DEFAULT_HAIKU_MODEL: 'qwen3.5-plus',
      }),
    ).toBe('qwen3.5-plus')
  })

  test('returns undefined when neither is configured (caller falls back)', () => {
    expect(resolveOpenAISmallFastModel({})).toBeUndefined()
  })

  test('never returns an Anthropic built-in model name', () => {
    const model = resolveOpenAISmallFastModel({
      OPENAI_DEFAULT_HAIKU_MODEL: 'qwen3.5-plus',
    })
    expect(model).not.toMatch(/^claude-haiku/)
  })
})
