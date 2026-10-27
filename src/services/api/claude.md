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
