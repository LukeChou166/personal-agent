import { z } from 'zod/v4'
import type { ToolResultBlockParam } from 'src/Tool.js'
import { buildTool } from 'src/Tool.js'
import { describeNode } from 'src/services/lossless/retrieval.js'
import { getSessionStore } from 'src/services/lossless/sessionStore.js'
import { isLosslessEnabled } from 'src/services/lossless/settings.js'
import { LCM_DESCRIBE_PROMPT, LCM_DESCRIBE_TOOL_NAME } from './prompt.js'

const inputSchema = z.strictObject({
  node_id: z.string().min(1).describe('摘要节点 id（来自 LcmGrep 的 node_id）'),
})
type Input = z.infer<typeof inputSchema>

type Output =
  | {
      node: {
        id: string
        depth: number
        kind: string
        span: { firstSeq: number; lastSeq: number }
        token_estimate: number
        model: string
        created_at: string
        status: string
        text: string
      }
      children: Array<{
        id: string
        depth: number
        span: { firstSeq: number; lastSeq: number }
      }>
      expandable_tokens: number
    }
  | { error: string }

export const LcmDescribeTool = buildTool({
  name: LCM_DESCRIBE_TOOL_NAME,
  searchHint: 'summary node span depth inspect context',
  maxResultSizeChars: 20_000,
  strict: true,

  get inputSchema() {
    return inputSchema
  },

  async description() {
    return '查看一个摘要节点覆盖的范围、层级与正文'
  },
  async prompt() {
    return LCM_DESCRIBE_PROMPT
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
    return LCM_DESCRIBE_TOOL_NAME
  },

  renderToolUseMessage(input: Partial<Input>) {
    return `LcmDescribe(${input.node_id ?? ''})`
  },

  async call(input: Input) {
    try {
      const { store } = getSessionStore()
      const described = describeNode(store, input.node_id)
      return { data: (described ?? { error: 'node_not_found' }) as Output }
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
