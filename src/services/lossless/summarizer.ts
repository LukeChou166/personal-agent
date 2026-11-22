/**
 * 摘要调用：把一段原文压成目标长度内的摘要。
 *
 * 走 `sideQuery` 是为了复用当前已配置的 provider 与鉴权，不引入独立密钥；
 * 超时与失败都收敛成 `null`，由引擎计入失败次数并决定是否熔断。
 */

import { sideQuery } from '../../utils/sideQuery.js'

export type SummarizeInput = { text: string; targetTokens: number }

/** 返回摘要正文；失败（超时、限流、空输出）返回 null。 */
export type SummarizeFn = (input: SummarizeInput) => Promise<string | null>

const SUMMARY_SYSTEM_PROMPT = [
  '你是对话历史压缩器。把用户提供的对话片段压成一段摘要。',
  '必须保留：结论、决策、文件路径、命令、错误原文关键行、未完成事项。',
  '不要编造原文没有的信息，不要评价，不要输出标题或前言。',
  '用与原文相同的语言输出。',
].join('\n')

export function createSummarizer(options: {
  model: string
  timeoutMs: number
}): SummarizeFn {
  return async ({ text, targetTokens }) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs)
    try {
      const response = await sideQuery({
        model: options.model,
        querySource: 'lossless_summary',
        system: SUMMARY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: text }],
        max_tokens: targetTokens,
        signal: controller.signal,
        optional: true,
      })
      const parts: string[] = []
      for (const block of response.content) {
        if (block.type === 'text') parts.push(block.text)
      }
      const summary = parts.join('\n').trim()
      return summary || null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}
