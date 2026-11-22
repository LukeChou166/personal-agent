import { z } from 'zod/v4'
import type { ToolResultBlockParam } from 'src/Tool.js'
import { buildTool } from 'src/Tool.js'
import { expandNode } from 'src/services/lossless/retrieval.js'
import { getSessionStore } from 'src/services/lossless/sessionStore.js'
import { isLosslessEnabled } from 'src/services/lossless/settings.js'
import { LCM_EXPAND_PROMPT, LCM_EXPAND_TOOL_NAME } from './prompt.js'

const inputSchema = z.strictObject({
  node_id: z.string().optional().describe('摘要节点 id'),
  message_ids: z.array(z.string()).optional().describe('直接指定消息 uuid'),
  max_tokens: z.number().int().min(200).max(8000).optional(),
})
type Input = z.infer<typeof inputSchema>

type Output =
  | {
      text: string
      messages: number
      tokens: number
      truncated: boolean
      next?: { start_seq: number }
    }
  | { error: string }

export const LcmExpandTool = buildTool({
  name: LCM_EXPAND_TOOL_NAME,
  searchHint: 'expand restore original text verbatim details',
  maxResultSizeChars: 40_000,
  strict: true,

  get inputSchema() {
    return inputSchema
  },

  async description() {
    return '把摘要节点或其覆盖的消息还原成原文片段'
  },
  async prompt() {
    return LCM_EXPAND_PROMPT
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
    return LCM_EXPAND_TOOL_NAME
  },

  renderToolUseMessage(input: Partial<Input>) {
    return `LcmExpand(${input.node_id ?? input.message_ids?.length ?? 0})`
  },

  async call(input: Input) {
    if (!input.node_id && !input.message_ids?.length) {
      return { data: { error: 'node_id or message_ids is required' } as Output }
    }
    try {
      const { store } = getSessionStore()
      const result = expandNode(store, {
        nodeId: input.node_id,
        messageIds: input.message_ids,
        maxTokens: input.max_tokens,
      })
      return {
        data: {
          text: result.text,
          messages: result.messages,
          tokens: result.tokens,
          truncated: result.truncated,
          next: result.next ? { start_seq: result.next.startSeq } : undefined,
        } as Output,
      }
    } catch (error) {
      return { data: { error: String(error) } as Output }
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
