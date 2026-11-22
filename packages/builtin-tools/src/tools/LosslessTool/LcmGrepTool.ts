import { z } from 'zod/v4'
import type { ToolResultBlockParam } from 'src/Tool.js'
import { buildTool } from 'src/Tool.js'
import { grepHistory } from 'src/services/lossless/retrieval.js'
import { getSessionStore } from 'src/services/lossless/sessionStore.js'
import { isLosslessEnabled } from 'src/services/lossless/settings.js'
import { LCM_GREP_PROMPT, LCM_GREP_TOOL_NAME } from './prompt.js'

const inputSchema = z.strictObject({
  pattern: z.string().min(1).describe('关键词，大小写无关子串'),
  limit: z.number().int().min(1).max(50).optional(),
  role: z.enum(['user', 'assistant', 'any']).optional(),
  node_id: z.string().optional().describe('仅在该摘要节点覆盖范围内检索'),
})
type Input = z.infer<typeof inputSchema>

type Output = {
  hits: Array<{
    message_id: string
    seq: number
    ts: string
    role: string
    snippet: string
    node_id?: string
    large: boolean
  }>
  total_matched: number
  scanned_messages: number
  truncated: boolean
  error?: string
}

export const LcmGrepTool = buildTool({
  name: LCM_GREP_TOOL_NAME,
  searchHint: 'search history transcript recall earlier messages keywords',
  maxResultSizeChars: 20_000,
  strict: true,

  get inputSchema() {
    return inputSchema
  },

  async description() {
    return '按关键词检索当前会话的本地历史（含已被摘要覆盖的消息）'
  },
  async prompt() {
    return LCM_GREP_PROMPT
  },

  isEnabled() {
    return isLosslessEnabled()
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  userFacingName() {
    return LCM_GREP_TOOL_NAME
  },

  renderToolUseMessage(input: Partial<Input>) {
    return `LcmGrep(${input.pattern ?? ''})`
  },

  async call(input: Input) {
    const limit = input.limit ?? 20
    try {
      const { store } = getSessionStore()
      const { hits, scanned } = grepHistory(store, {
        pattern: input.pattern,
        limit,
        role: input.role,
        nodeId: input.node_id,
      })
      const data: Output = {
        hits: hits.map(hit => ({
          message_id: hit.messageId,
          seq: hit.seq,
          ts: hit.ts,
          role: hit.role,
          snippet: hit.snippet,
          node_id: hit.nodeId,
          large: hit.large,
        })),
        total_matched: hits.length,
        scanned_messages: scanned,
        truncated: hits.length >= limit,
      }
      return { data }
    } catch (error) {
      return {
        data: {
          hits: [],
          total_matched: 0,
          scanned_messages: 0,
          truncated: false,
          error: String(error),
        } as Output,
      }
    }
  },

  mapToolResultToToolResultBlockParam(
    content: Output,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: JSON.stringify(content),
    }
  },
})
