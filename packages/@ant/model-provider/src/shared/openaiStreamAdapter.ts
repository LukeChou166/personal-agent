import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions.mjs'
import { randomUUID } from 'crypto'
import { normalizeOpenAIUsage } from './openaiUsage.js'
import { learningLog } from 'src/utils/learningLog.js'

/**
 * Adapt an OpenAI streaming response into Anthropic BetaRawMessageStreamEvent.
 *
 * Mapping:
 *   First chunk              → message_start
 *   delta.reasoning_content  → content_block_start(thinking) + thinking_delta + content_block_stop
 *   delta.content            → content_block_start(text) + text_delta + content_block_stop
 *   delta.tool_calls         → content_block_start(tool_use) + input_json_delta + content_block_stop
 *   finish_reason            → message_delta(stop_reason) + message_stop
 *
 * Usage field mapping (OpenAI → Anthropic):
 *   prompt_tokens - cached_tokens - cache_write_tokens → input_tokens
 *   completion_tokens                         → output_tokens
 *   prompt_tokens_details.cached_tokens       → cache_read_input_tokens
 *   prompt_tokens_details.cache_write_tokens  → cache_creation_input_tokens
 *
 *   All four fields are emitted in the post-loop message_delta (not message_start)
 *   so that trailing usage chunks (sent after finish_reason by some
 *   OpenAI-compatible endpoints) are fully captured before the final counts are reported.
 *
 * Thinking support:
 *   DeepSeek and compatible providers send `delta.reasoning_content` for chain-of-thought.
 *   This is mapped to Anthropic's `thinking` content blocks:
 *     content_block_start: { type: 'thinking', thinking: '', signature: '' }
 *     content_block_delta: { type: 'thinking_delta', thinking: '...' }
 *
 * Prompt caching:
 *   OpenAI reports cached tokens in usage.prompt_tokens_details.cached_tokens.
 *   This is mapped to Anthropic's cache_read_input_tokens.
 */
/**
 * Incremental payload shape shared by streaming (`delta`) and non-streaming
 * (`message`) Chat Completions responses.
 */
type CompatDelta = {
  content?: string | null
  reasoning_content?: string | null
  tool_calls?:
    | {
        index?: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }[]
    | null
}

type CompatChunk = {
  choices?:
    | {
        delta?: CompatDelta | null
        message?: CompatDelta | null
        finish_reason?: string | null
      }[]
    | null
  usage?: {
    prompt_tokens?: number | null
    completion_tokens?: number | null
  } | null
}

const EMPTY_DELTA: CompatDelta = {}

/**
 * Normalize whatever the endpoint handed us into a CompatChunk.
 *
 * Two shapes have to be handled because they both reach this adapter:
 * 1. Some gateways/bridges wrap the payload in `{ body, is_complete }` instead
 *    of returning the Chat Completion object directly. Without unwrapping,
 *    `choices` is unreachable and the whole response is silently dropped.
 * 2. `usage` may live on the envelope rather than on the inner payload, so
 *    fall back to the outer object when the inner one has none.
 */
function toCompatChunk(raw: unknown): CompatChunk {
  learningLog('openaiStreamAdapter.toCompatChunk start', { raw })
  if (typeof raw !== 'object' || raw === null) return {}
  const outer = raw as Record<string, unknown>
  const body = outer.body
  const source =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : outer
  const innerUsage =
    typeof source.usage === 'object' && source.usage !== null
      ? source.usage
      : undefined
  return {
    choices: (source.choices ?? undefined) as unknown as CompatChunk['choices'],
    usage: (innerUsage ??
      outer.usage ??
      undefined) as unknown as CompatChunk['usage'],
  }
}

export async function* adaptOpenAIStreamToAnthropic(
  stream: AsyncIterable<ChatCompletionChunk>,
  model: string,
  options?: { includeCacheWriteTokens?: boolean },
): AsyncGenerator<BetaRawMessageStreamEvent, void> {
  learningLog('openaiStreamAdapter.adaptOpenAIStreamToAnthropic start')
  const messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`

  let started = false
  let currentContentIndex = -1

  // Track tool_use blocks: tool_calls index → { contentIndex, id, name, arguments }
  const toolBlocks = new Map<
    number,
    { contentIndex: number; id: string; name: string; arguments: string }
  >()
  learningLog('openaiStreamAdapter.toolBlocks start', { toolBlocks })
  // Index of the currently open thinking / text block, or -1 when none is open.
  //
  // These MUST be tracked separately rather than as two booleans plus a shared
  // cursor. A model may emit reasoning again after it has started answering
  // (or interleave the two). With a shared cursor the new thinking block takes
  // the next index, and every subsequent text_delta — emitted against that
  // cursor — lands on the *thinking* block's index, so answer text gets
  // appended into `thinking` and the real text block is left truncated.
  let thinkingBlockIndex = -1
  let textBlockIndex = -1

  // Close helpers. `yield*` delegation keeps emit ordering identical to the
  // previous inline version while letting every branch share the logic.
  function* closeThinking(): Generator<BetaRawMessageStreamEvent, void> {
    if (thinkingBlockIndex < 0) return
    yield {
      type: 'content_block_stop',
      index: thinkingBlockIndex,
    } as BetaRawMessageStreamEvent
    openBlockIndices.delete(thinkingBlockIndex)
    thinkingBlockIndex = -1
  }

  function* closeText(): Generator<BetaRawMessageStreamEvent, void> {
    if (textBlockIndex < 0) return
    yield {
      type: 'content_block_stop',
      index: textBlockIndex,
    } as BetaRawMessageStreamEvent
    openBlockIndices.delete(textBlockIndex)
    textBlockIndex = -1
  }

  function* closeAllContent(): Generator<BetaRawMessageStreamEvent, void> {
    yield* closeThinking()
    yield* closeText()
  }

  // Track raw OpenAI usage across chunks. The normalized Anthropic fields are
  // disjoint: ordinary input + cache reads + cache writes = total input.
  let rawInputTokens = 0
  let outputTokens = 0
  let rawCacheReadTokens = 0
  let rawCacheWriteTokens = 0
  let usage = normalizeOpenAIUsage({ totalInputTokens: 0, outputTokens: 0 })

  // Track all open content block indices (for cleanup)
  const openBlockIndices = new Set<number>()

  // Deferred finish state
  let pendingFinishReason: string | null = null
  let pendingHasToolCalls = false

  for await (const rawChunk of stream) {
    const chunk = toCompatChunk(rawChunk)
    const choice = chunk.choices?.[0]
    // Streaming sends incremental text in `choices[0].delta`; non-streaming
    // (and gateways that buffer the whole completion) send the finished text
    // in `choices[0].message`. Read whichever is present.
    const delta = choice?.delta ?? choice?.message

    // Extract usage from any chunk that carries it.
    learningLog('openaiStreamAdapter.adaptOpenAIStreamToAnthropic chunk', {
      chunk,
    })
    if (chunk.usage) {
      rawInputTokens = chunk.usage.prompt_tokens ?? rawInputTokens
      outputTokens = chunk.usage.completion_tokens ?? outputTokens

      const usageRecord = chunk.usage as unknown as Record<string, unknown>
      const detailsValue = usageRecord.prompt_tokens_details
      const details =
        detailsValue && typeof detailsValue === 'object'
          ? (detailsValue as Record<string, unknown>)
          : undefined
      if (typeof details?.cached_tokens === 'number') {
        rawCacheReadTokens = details.cached_tokens
      }
      if (
        options?.includeCacheWriteTokens &&
        typeof details?.cache_write_tokens === 'number'
      ) {
        rawCacheWriteTokens = details.cache_write_tokens
      } else if (!options?.includeCacheWriteTokens) {
        rawCacheWriteTokens = 0
      }

      usage = normalizeOpenAIUsage({
        totalInputTokens: rawInputTokens,
        outputTokens,
        cacheReadTokens: rawCacheReadTokens,
        cacheWriteTokens: rawCacheWriteTokens,
      })
    }

    // Emit message_start on first chunk
    if (!started) {
      started = true

      yield {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            ...usage,
            output_tokens: 0,
          },
        },
      } as unknown as BetaRawMessageStreamEvent
    }

    // Skip chunks that carry only usage data (no delta content).
    // A chunk with a finish_reason must NOT be skipped even when it has no
    // delta: some endpoints send the terminator as `{ delta: {}, finish_reason }`
    // and non-streaming payloads have no delta at all. Skipping them left
    // pendingFinishReason null, so message_delta/message_stop were never
    // emitted and the whole message was silently dropped downstream.
    if (!delta && !choice?.finish_reason) continue

    // A finish-only chunk has no delta; substitute an empty one so the content
    // handlers below can read fields without per-access null checks.
    const payload = delta ?? EMPTY_DELTA

    // Handle reasoning_content → Anthropic thinking block.
    // Empty string is a valid signal: DeepSeek v4 thinking mode sometimes
    // returns reasoning_content: "" when the model answers directly. The
    // empty thinking block must round-trip back to the API in subsequent
    // requests, otherwise DeepSeek rejects with 400.
    const reasoningContent = payload.reasoning_content
    if (reasoningContent != null) {
      // An empty reasoning_content may only open a block when nothing has been
      // emitted yet — DeepSeek v4 sends "" and still requires the (empty)
      // thinking block to round-trip back on the next request.
      //
      // Endpoints that repeat `reasoning_content: ""` on EVERY chunk would
      // otherwise oscillate: each chunk re-opens a thinking block (because the
      // previous one was already closed when the answer started), which closes
      // the text block, which forces the next `content` to open yet another
      // text block — one content block per delta. Downstream that renders as
      // one line per fragment and floods the message with empty thinking
      // blocks.
      const opensFirstBlock = currentContentIndex < 0
      const canOpenThinking =
        thinkingBlockIndex < 0 && (reasoningContent !== '' || opensFirstBlock)

      if (canOpenThinking) {
        // Close the text block first when reasoning resumes mid-answer.
        // Otherwise the new thinking block claims the next index and later
        // text_delta events would be attributed to it.
        yield* closeText()

        currentContentIndex++
        thinkingBlockIndex = currentContentIndex
        openBlockIndices.add(thinkingBlockIndex)

        yield {
          type: 'content_block_start',
          index: thinkingBlockIndex,
          content_block: {
            type: 'thinking',
            thinking: '',
            signature: '',
          },
        } as BetaRawMessageStreamEvent
      }

      if (thinkingBlockIndex >= 0 && reasoningContent !== '') {
        yield {
          type: 'content_block_delta',
          index: thinkingBlockIndex,
          delta: {
            type: 'thinking_delta',
            thinking: reasoningContent,
          },
        } as BetaRawMessageStreamEvent
      }
    }

    // Handle text content
    if (payload.content != null && payload.content !== '') {
      if (textBlockIndex < 0) {
        // Close thinking block if still open
        yield* closeThinking()

        currentContentIndex++
        textBlockIndex = currentContentIndex
        openBlockIndices.add(textBlockIndex)

        yield {
          type: 'content_block_start',
          index: textBlockIndex,
          content_block: {
            type: 'text',
            text: '',
          },
        } as BetaRawMessageStreamEvent
      }

      yield {
        type: 'content_block_delta',
        index: textBlockIndex,
        delta: {
          type: 'text_delta',
          text: payload.content,
        },
      } as BetaRawMessageStreamEvent
    }

    // Handle tool calls
    if (payload.tool_calls) {
      for (const tc of payload.tool_calls) {
        // Non-streaming tool_calls carry no `index`; synthesize one so multiple
        // calls don't collapse onto the same map key.
        const tcIndex = tc.index ?? toolBlocks.size

        if (!toolBlocks.has(tcIndex)) {
          yield* closeAllContent()

          // Start new tool_use block
          currentContentIndex++
          const toolId =
            tc.id || `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`
          const toolName = tc.function?.name || ''

          toolBlocks.set(tcIndex, {
            contentIndex: currentContentIndex,
            id: toolId,
            name: toolName,
            arguments: '',
          })
          openBlockIndices.add(currentContentIndex)

          yield {
            type: 'content_block_start',
            index: currentContentIndex,
            content_block: {
              type: 'tool_use',
              id: toolId,
              name: toolName,
              input: {},
            },
          } as BetaRawMessageStreamEvent
        }

        // Stream argument fragments
        const argFragment = tc.function?.arguments
        if (argFragment) {
          toolBlocks.get(tcIndex)!.arguments += argFragment
          yield {
            type: 'content_block_delta',
            index: toolBlocks.get(tcIndex)!.contentIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: argFragment,
            },
          } as BetaRawMessageStreamEvent
        }
      }
    }

    // Handle finish.
    // Only the finish state is recorded here — blocks stay open and are closed
    // by the sweep below. Some endpoints emit a non-null finish_reason on a
    // non-final chunk and keep streaming content afterwards; closing here used
    // to force every later chunk into a brand-new second text block.
    if (choice?.finish_reason) {
      pendingFinishReason = choice.finish_reason
      pendingHasToolCalls = toolBlocks.size > 0
    }
  }

  // Close any remaining open blocks. Iterating the Set preserves ascending
  // index order, so the stop events stay correctly sequenced.
  for (const idx of openBlockIndices) {
    yield {
      type: 'content_block_stop',
      index: idx,
    } as BetaRawMessageStreamEvent
  }
  openBlockIndices.clear()
  thinkingBlockIndex = -1
  textBlockIndex = -1

  // Emit message_delta + message_stop.
  // Gated on `started` rather than on pendingFinishReason: an endpoint that
  // omits finish_reason entirely used to produce no message_stop at all, so
  // downstream never assembled an AssistantMessage and the reply vanished
  // without any error. Default such responses to end_turn.
  if (started) {
    const stopReason =
      pendingFinishReason === 'length'
        ? 'max_tokens'
        : pendingHasToolCalls
          ? 'tool_use'
          : pendingFinishReason
            ? mapFinishReason(pendingFinishReason)
            : 'end_turn'

    yield {
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
      },
      usage,
    } as BetaRawMessageStreamEvent

    yield {
      type: 'message_stop',
    } as BetaRawMessageStreamEvent
  }
}

/**
 * Map OpenAI finish_reason to Anthropic stop_reason.
 */
function mapFinishReason(reason: string): string {
  switch (reason) {
    case 'stop':
      return 'end_turn'
    case 'tool_calls':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    case 'content_filter':
      return 'end_turn'
    default:
      return 'end_turn'
  }
}
