/**
 * 无损压缩的运行时编排：取会话存储 → 跑分层摘要 → 装配成压缩结果。
 *
 * 护栏状态在本轮内闭包维护，等引擎写完 backlog 后再合并落盘，避免
 * 两次 meta 写入互相覆盖。
 */

import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import type { CompactionResult } from '../compact/compact.js'
import { buildLosslessCompaction } from './assembler.js'
import { createEngine } from './engine.js'
import {
  evaluateGuard,
  recordGuardCall,
  recordGuardFailure,
  type GuardConfig,
} from './guard.js'
import { getSessionStore } from './sessionStore.js'
import { createSummarizer, type SummarizeFn } from './summarizer.js'
import type { GuardState } from './store.js'

export async function runLosslessCompaction(
  messages: Message[],
  context: ToolUseContext,
  trigger: 'auto' | 'manual',
): Promise<CompactionResult> {
  const { store, config, session } = getSessionStore()
  const model = config.summaryModel ?? context.options.mainLoopModel
  const guardConfig: GuardConfig = {
    windowMs: config.summaryCallWindowMs,
    maxCallsPerWindow: config.summaryMaxCallsPerWindow,
    backoffMs: config.summarySpendBackoffMs,
  }
  const baseSummarize = createSummarizer({
    model,
    timeoutMs: config.summaryTimeoutMs,
  })

  let guardState: GuardState | undefined = store.readMeta()?.guard
  const summarize: SummarizeFn = async input => {
    if (!evaluateGuard(guardState, guardConfig).allowed) return null
    guardState = recordGuardCall(guardState, guardConfig)
    const summary = await baseSummarize(input)
    if (!summary) guardState = recordGuardFailure(guardState, guardConfig)
    return summary
  }

  const engine = createEngine({
    store,
    config: {
      freshTailCount: config.freshTailCount,
      leafChunkTokens: config.leafChunkTokens,
      leafMinFanout: config.leafMinFanout,
      leafTargetTokens: config.leafTargetTokens,
      condensedMinFanout: config.condensedMinFanout,
      condensedTargetTokens: config.condensedTargetTokens,
      incrementalMaxDepth: config.incrementalMaxDepth,
    },
    summarize,
    model,
    session: { sessionId: session.sessionId, projectKey: session.projectKey },
  })

  await engine.run()

  const meta = store.readMeta()
  if (meta && guardState) {
    store.writeMeta({
      ...meta,
      guard: guardState,
      updatedAt: new Date().toISOString(),
    })
  }

  const { nodes } = store.readNodes()
  return buildLosslessCompaction({
    messages,
    nodes,
    freshTailCount: config.freshTailCount,
    trigger,
    preCompactTokenCount: tokenCountWithEstimation(messages),
  })
}
