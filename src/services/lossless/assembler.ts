/**
 * 上下文装配：把「根摘要 + 新鲜尾巴」包装成既有压缩契约（CompactionResult）。
 *
 * 复用 `createCompactBoundaryMessage` / `createUserMessage`，让 REPL 与
 * headless 两侧不需要为无损模式改动消息渲染逻辑。
 */

import type { Message } from '../../types/message.js'
import {
  createCompactBoundaryMessage,
  createUserMessage,
} from '../../utils/messages.js'
import type { CompactionResult } from '../compact/compact.js'
import type { SummaryNode } from './store.js'

/** 注入上下文的摘要正文上限（约 8k token），超出保留最近部分。 */
const MAX_SUMMARY_CHARS = 32_000

export function buildLosslessCompaction(input: {
  messages: Message[]
  nodes: SummaryNode[]
  freshTailCount: number
  trigger: 'auto' | 'manual'
  preCompactTokenCount: number
}): CompactionResult {
  const boundaryMarker = createCompactBoundaryMessage(
    input.trigger,
    input.preCompactTokenCount,
    input.messages.at(-1)?.uuid,
  )

  const parented = new Set(input.nodes.flatMap(node => node.childNodeIds))
  const roots = input.nodes
    .filter(node => !parented.has(node.id))
    .sort((a, b) => a.span.firstSeq - b.span.firstSeq)

  const joined = roots
    .map(node => node.text.trim())
    .filter(Boolean)
    .join('\n\n')
  const summary = joined.slice(-MAX_SUMMARY_CHARS)

  const summaryMessages = summary
    ? [
        createUserMessage({
          content: `以下是此前的分层摘要（原文可按需检索/展开）：\n\n${summary}`,
          isCompactSummary: true,
          isVisibleInTranscriptOnly: true,
        }),
      ]
    : []

  return {
    boundaryMarker,
    summaryMessages,
    attachments: [],
    hookResults: [],
    messagesToKeep: input.messages.slice(-input.freshTailCount),
    preCompactTokenCount: input.preCompactTokenCount,
  }
}
