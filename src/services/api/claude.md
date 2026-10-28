# queryModel 定义与调用点

> 目标源文件：`src/services/api/claude.ts`
> 最后更新：2026-10-26

## 1. 定义

`queryModel` 是 `src/services/api/claude.ts` 内部私有的异步生成器，**未被 export**，模块外无法直接调用：

- `src/services/api/claude.ts:1049` — `async function* queryModel(messages, systemPrompt, thinkingConfig, tools, signal, options)`

签名类型为 `AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void>`。

它负责：构造 betas / 系统提示词 / 工具 schema → 归一化消息 → 按 provider 分发 → 发起 SSE 流式请求 → 逐事件累积成 `AssistantMessage` 并 yield → 失败时降级为 non-streaming → 用量/成本/埋点上报。

## 2. 直接被调用的位置（仅 2 处，都在本文件内）

| 调用点 | 所在函数 | 说明 |
|--------|----------|------|
| `src/services/api/claude.ts:751` | `queryModelWithoutStreaming`（定义于 `src/services/api/claude.ts:732`） | 包在 `withStreamingVCR(messages, async function* () { yield* queryModel(...) })` 内，迭代完取最后一条 assistant message 返回 |
| `src/services/api/claude.ts:794` | `queryModelWithStreaming`（定义于 `src/services/api/claude.ts:775`） | 同样包在 `withStreamingVCR` 内，直接转发 stream 事件 |

因此外部所有"查询模型"的入口都是这两个导出包装函数，而不是 `queryModel` 本身。

## 3. Provider 分发（在 queryModel 内部）

`queryModel` 在共享预处理（消息归一化、工具过滤、媒体裁剪）之后、Anthropic 专有逻辑之前，按 provider 委派：

- `openai` → `src/services/api/claude.ts:1357` → `yield* queryModelOpenAI(...)`（`src/services/api/openai/index.ts:220`）
- `gemini` → `src/services/api/claude.ts:1369` → `yield* queryModelGemini(...)`（`src/services/api/gemini/index.ts:40`）
- `grok` → `src/services/api/claude.ts:1382` → `yield* queryModelGrok(...)`（`src/services/api/grok/index.ts:51`）
- 其余（firstParty / bedrock / vertex / foundry）→ 继续走本函数内的 Anthropic SDK 流式分支（`anthropic.beta.messages.create` 在 `src/services/api/claude.ts:1945`）

## 4. 上游调用链

### 4.1 流式：`queryModelWithStreaming`

```
queryModel (src/services/api/claude.ts:1049)
  └─ queryModelWithStreaming (src/services/api/claude.ts:775)
       ├─ [主链路] src/query/deps.ts:23,35  →  QueryDeps.callModel
       │      └─ src/query.ts:430  const deps = params.deps ?? productionDeps()
       │           └─ src/query.ts:928  for await (const message of deps.callModel({...}))
       │                ↑ query() 是唯一的 Agent 主循环 API 调用点
       ├─ src/services/compact/compact.ts:1332  （compact 摘要流式生成）
       └─ packages/builtin-tools/src/tools/WebSearchTool/adapters/apiAdapter.ts:61  （ApiSearchAdapter.search）
```

`src/query.ts:256` 的 `deps?: QueryDeps` 允许测试直接注入假实现（见 `src/__tests__/queryAutonomyProviderBoundary.test.ts:179`、`:278`）。

`query()` 的上层调用者（即最终触达 `queryModel` 的业务入口）：

- `src/screens/REPL.tsx:269`（交互式 REPL 主循环）
- `src/QueryEngine.ts:36`（对话编排，含 compaction / 快照）
- `packages/builtin-tools/src/tools/AgentTool/runAgent.ts:15`（子 Agent）
- `src/tasks/LocalMainSessionTask.ts:22`
- `src/utils/forkedAgent.ts:16`
- `src/utils/hooks/execAgentHook.ts:3`

### 4.2 非流式：`queryModelWithoutStreaming`

直接调用点：

- `src/services/api/claude.ts:3507` — 被 `queryHaiku`（`src/services/api/claude.ts:3478`）调用
- `src/services/api/claude.ts:3566` — 被 `queryWithModel`（`src/services/api/claude.ts:3537`）调用
- `src/components/agents/generateAgent.ts:165` — 生成 Agent 定义
- `src/services/awaySummary.ts:62` — AWAY_SUMMARY
- `src/utils/hooks/apiQueryHookHelper.ts:85` — 通用 API query hook
- `src/utils/hooks/execPromptHook.ts:62` — prompt 类型 hook
- `src/utils/hooks/skillImprovement.ts:239` — skill 自动改进

### 4.3 `queryHaiku` 的下游调用点（间接进 queryModel）

- `src/services/toolUseSummary/toolUseSummaryGenerator.ts:69`
- `src/services/skillLearning/llmObserverBackend.ts:95`
- `src/services/skillSearch/intentNormalize.ts:125`
- `src/commands/rename/generateSessionName.ts:20`
- `src/utils/sessionTitle.ts:92`
- `src/utils/mcp/dateTimeParser.ts:68`
- `src/utils/shell/prefix.ts:219`
- `src/utils/teleport.tsx:126`
- `src/components/Feedback.tsx:510`
- `packages/builtin-tools/src/tools/WebFetchTool/utils.ts:562`

### 4.4 `queryWithModel` 的调用点（间接进 queryModel）

- `src/commands/insights.ts:855` — `summarizeTranscriptChunk`
- `src/commands/insights.ts:1000` — `extractFacetsFromAPI`
- `src/commands/insights.ts:1553` — `generateSectionInsight`

## 5. 一句话总结

`queryModel` 对外不可见；实际只有 `queryModelWithStreaming` 与 `queryModelWithoutStreaming` 两个包装器调用它。主对话链路是 `REPL/Agent → query() → QueryDeps.callModel → queryModelWithStreaming → queryModel`，此外还有 compact、WebSearch adapter（流式）和 queryHaiku / queryWithModel / 各类 hook（非流式）等旁路入口。

---

# 模型回复「异常截断」排查

> 排查日期：2026-10-28

## A. 结果解析代码的精确位置

模型结果**唯一**的解析/累积点就是 `queryModel()` 内的 SSE 事件循环（firstParty / bedrock / vertex / foundry 共用；OpenAI / Gemini / Grok 走各自的适配器，见 §3）。

| 环节 | 位置 | 说明 |
|------|------|------|
| 发起流式请求 | `src/services/api/claude.ts:1945` | `anthropic.beta.messages.create(...).withResponse()`，返回 **raw `Stream<BetaRawMessageStreamEvent>`**（非 `BetaMessageStream`，见 `:1947` 注释，为规避 O(n²) 解析） |
| 主事件循环 | `src/services/api/claude.ts:2077` | `for await (const part of stream)` |
| 事件分派 | `src/services/api/claude.ts:2121` | `switch (part.type)`：`message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop` |
| 文本 delta 累积 | `src/services/api/claude.ts:2284` | `textDeltas.get(part.index)?.push(delta.text!)` — **只 push 进数组，不写入 contentBlock.text** |
| 文本合并 + 产出消息 | `src/services/api/claude.ts:2352-2394` | 仅在 `content_block_stop` 时 `deltas.join('')` → `normalizeContentFromAPI` → 构造 `AssistantMessage` → `yield m` |
| stop_reason / usage 回写 | `src/services/api/claude.ts:2430-2436` | 只回写 `newMessages.at(-1)` |
| 截断检测 | `src/services/api/claude.ts:2457` / `:2470` | `stop_reason === 'max_tokens'` / `'model_context_window_exceeded'` → yield `createAssistantAPIErrorMessage({ apiError: 'max_output_tokens' })` |
| 流完整性兜底 | `src/services/api/claude.ts:2543` | `if (!partialMessage \|\| (newMessages.length === 0 && !stopReason))` → throw 触发非流式回退 |
| 断流回退 | `src/services/api/claude.ts:2607-2808` | catch → `executeNonStreamingRequest()` |
| 上层恢复循环 | `src/query.ts:1505-1573` | `isWithheldMaxOutputTokens` → escalate 64k / 多轮 recovery |

## B. 可疑点（按可能性排序）

### B1【最高嫌疑】`max_tokens` 默认被压到 8000（slot-reservation cap）

- `src/utils/context.ts:29` — `CAPPED_DEFAULT_MAX_TOKENS = 8_000`，`ESCALATED_MAX_TOKENS = 64_000`
- `src/services/api/claude.ts:3644-3663` `getMaxOutputTokensForModel()`：当 GrowthBook flag `tengu_otk_slot_v1` 为 true 时，`defaultTokens = Math.min(nativeDefault, 8000)`。即 **Sonnet/Opus 原生 32k/64k 默认会被压到 8k**
- `src/services/api/claude.ts:1686-1689` 优先级：`retryContext?.maxTokensOverride || options.maxOutputTokensOverride || getMaxOutputTokensForModel(model)`
- 命中上限 → `src/services/api/claude.ts:2457` yield `max_output_tokens` 错误
- `src/query.ts:1512-1538` 恢复：只有 `capEnabled && maxOutputTokensOverride === undefined && !process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS` 才 escalate 到 64k 重试一次；否则走 `src/query.ts:1540` 的多轮「接着写」recovery（上限 `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3`，`src/query.ts:195`）

**失效窗口（真正的 bug 面）**：`capEnabled` 在 `src/query.ts:1512` 是**重新读一次** `getFeatureValue_CACHED_MAY_BE_STALE('tengu_otk_slot_v1', false)`，而非沿用发请求时（`src/services/api/claude.ts:3641`）的值。函数名已明示 "MAY BE STALE"。代码在 PTL 路径上已经因为同样的原因做过 hoist（`src/query.ts:842-846` 注释明确写了 "CACHED_MAY_BE_STALE can flip during the 5-30s stream, and withhold-without-recover would eat the message"），但 **max_output_tokens 这条路径没有做 hoist**。若 flag 在流式期间翻转：请求按 8k 发 → 命中截断 → `capEnabled` 读到 false → **既不 escalate 也不 recovery，错误被 `src/query.ts:1103-1108` 的 withhold 吞掉** → 用户只看到回复凭空截断，无任何报错。

**验证/规避**：
- 临时绕过：设置 `CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000`（`src/services/api/claude.ts:3657` env 优先级最高）
- 确认是否命中：查日志 `tengu_max_tokens_reached`（`src/services/api/claude.ts:2458`）、`tengu_max_tokens_escalate`（`src/query.ts:1521`）

### B2【高】`textDeltas` 延迟合并 + 兜底条件过松 → 未闭合 block 静默丢失

`src/services/api/claude.ts:2284` 只把文本 delta 攒进 `textDeltas` Map，**只有收到 `content_block_stop` 才合并成 `text` 并 yield**（`:2352-2357`）。

后果：若流在**第二个及以后**的 text block 中途断开（网络抖动 / SDK timeout / watchdog abort），这段文本永远不会被 yield。而 `:2543` 的兜底只在"一个 block 都没完成"时才报错回退：

```
if (!partialMessage || (newMessages.length === 0 && !stopReason))
```

只要已有 ≥1 个 block 完成（多段文本 / thinking+text / text+tool_use 的常规 turn 都满足），条件为 false → **不抛错、不回退、静默吞掉**。表现正是「前半段正常、后半段凭空消失」。

**次生风险**：`textDeltas` 只在 `content_block_start` 的 `case 'text'` 分支 `set`（`:2176`）。若 content block 走了 `default` 分支（`:2196-2207`，未知/新型 type），`textDeltas` 未 set，后续所有 `text_delta` 被 `?.` **静默丢弃**；同理 `:2356` `textDeltas.delete(part.index)` 之后若同 index 再来 delta（乱序/重传），也会被静默丢弃。

### B3【中】watchdog 默认关闭

`src/services/api/claude.ts:2009-2013`：需 `CLAUDE_ENABLE_STREAM_WATCHDOG` 才启用，默认 90s 无 chunk 也不主动 abort，只能等 SDK timeout，期间表现为"卡住后截断"。

### B4【中】`message_delta` 只回写最后一条消息

`src/services/api/claude.ts:2432` `newMessages.at(-1)`：一个 turn 产出多个 content block 时，前面那些 message 的 `usage` / `stop_reason` 停留在 `message_start` 时的 `0` / `null`（注释 `:2417-2429` 已说明）。若上层按 `stop_reason` 判断完整性，会误判。

### B5【中】`retryContext.maxTokensOverride` 残留覆盖 escalate

`src/services/api/withRetry.ts:416` 在 context-overflow 时会写入 `retryContext.maxTokensOverride`。因 `src/services/api/claude.ts:1686` 中 `retryContext` 优先级**高于** `options.maxOutputTokensOverride`，若该值在重试间残留，会把 query.ts  escalate 的 64k 覆盖回小值，导致 escalate 空转。

### B6【低】兼容层流适配器

`src/services/api/openai/index.ts`、`src/services/api/openai/responsesAdapter.ts`、`src/services/api/gemini/index.ts`、`src/services/api/grok/index.ts` 各自的 SSE→Anthropic 事件转换，存在丢 chunk 的独立分支，仅在 `CLAUDE_CODE_USE_OPENAI/GEMINI/GROK=1` 时相关。

## C. 建议的修复方向

1. **B1**：把 `tengu_otk_slot_v1` 在 turn 开始时 hoist 一次（照抄 `src/query.ts:847` `mediaRecoveryEnabled` 的做法），供 `src/services/api/claude.ts:3641` 与 `src/query.ts:1512` 共用，消除 withhold-without-recover 窗口。
2. **B2**：把兜底条件从 `newMessages.length === 0` 改为"存在未被 `content_block_stop` 闭合的 content block"（用 `contentBlocks` 与已完成 index 集合比对），让中途断流也能触发非流式回退；`textDeltas.get(...)?.push()` 改为在缺失时记 `tengu_streaming_error` 而非静默丢弃。
3. **B5**：`executeNonStreamingRequest` / 重试进入时重置 `retryContext.maxTokensOverride`，或让 `options.maxOutputTokensOverride` 优先级高于 `retryContext`。

## D. 定位时该看的日志

- `tengu_max_tokens_reached` — `src/services/api/claude.ts:2458`（确认 B1）
- `tengu_max_tokens_escalate` — `src/query.ts:1521`（确认 escalate 是否触发）
- `tengu_stream_no_events` — `src/services/api/claude.ts:2550`（确认 B2 的"零事件"分支）
- `tengu_streaming_error` — `src/services/api/claude.ts:2215` 等（确认 delta 丢失）
- `tengu_streaming_idle_timeout` — `src/services/api/claude.ts:2054`（确认 B3）
- `api.content_block_stop` 的 `chars` 字段 — `src/services/api/claude.ts:2383`（对比实际收到的文本长度）
