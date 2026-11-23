# src/query.ts —— 模型返回 tool_use 后的执行链路

> 问题：模型返回 `tool_calls: [{ id: "call_046d...", type: "function", function: { name: "WebFetch", arguments: { url, prompt } } }]` 之后，本仓库内部怎么走？

## 0. 一条总览

```text
模型流式响应
  └─ claude.ts:2147  content_block_start(tool_use) → input:'' 占位
     claude.ts:2246  input_json_delta → 逐段拼 JSON
  └─ query.ts:1109   收到 assistant 消息 → 抽 tool_use 块 → toolUseBlocks / needsFollowUp=true
  └─ query.ts:1703   runTools(toolUseBlocks, assistantMessages, canUseTool, ctx)
       └─ toolOrchestration.ts:20   runTools
            ├─ :106 partitionToolCalls  按 isConcurrencySafe 分批
            ├─ :169 runToolsConcurrently（只读工具，并发上限 10）
            └─ :133 runToolsSerially（非只读，串行）
                 └─ toolExecution.ts:366  runToolUse（单个工具）
                      ├─ :374 findToolByName → 找不到则 :427 返回 "No such tool available"(is_error)
                      └─ :521 streamedCheckPermissionsAndCallTool → :641 checkPermissionsAndCallTool
                           ├─ :657  inputSchema.safeParse + :725 tool.validateInput
                           ├─ :840  PreToolUse hooks
                           ├─ :963  resolveHookPermissionDecision → toolHooks.ts:340
                           │         → permissions.ts:1141 tool.checkPermissions
                           ├─ :1037 拒绝 → :1072 造 is_error=true 的 tool_result
                           ├─ :1256 tool.call(...)   ← 真正执行
                           ├─ :1367 tool.mapToolResultToToolResultBlockParam(...)
                           ├─ :1484 超阈值落盘（maxResultSizeChars / 50_000）
                           └─ :1531 createUserMessage({ content:[tool_result] })
  └─ query.ts:1707   把每条 user(tool_result) 收进 toolResults
  └─ query.ts:2081   state.messages = messagesForQuery.concat(assistantMessages, toolResults)
  └─ query.ts:480    while(true) 下一轮 → 再次 callModel（query.ts:928-933）
```

## 1. 流式解析：tool_use 块是怎么攒出来的

- `src/services/api/claude.ts:2147-2152`：`content_block_start` 且 `content_block.type === 'tool_use'` 时，先建 `{...block, input: ''}`。
- `src/services/api/claude.ts:2246-2260`：`input_json_delta` 把 `partial_json` 追加进 `input` 字符串（不走 SDK 的 `partialParse`，注释见 claude.ts:1947-1949，避免 O(n²)）。
- 用户贴的 OpenAI 格式（`type:"function"` / `function.arguments`）是**兼容层**的形态：若走 `CLAUDE_CODE_USE_OPENAI=1`，由 `src/services/api/openai/index.ts:441-447` 把 OpenAI delta 翻译成上述 Anthropic 事件；`openai/index.ts:149-197`（`assembleFinalAssistantOutputs`）在 `message_stop` 时按 index 排序 `contentBlocks` 组装成**一条** AssistantMessage（`allBlocks.length > 0` 才产出，见 :179）。

## 2. query.ts：收集与判定

- `src/query.ts:480`：`while (true)` 主循环，每轮 = 一次模型调用 + 一批工具执行。
- `src/query.ts:772-779`：本轮容器 `assistantMessages` / `toolResults` / `toolUseBlocks` / `needsFollowUp`。
- `src/query.ts:1109-1133`：收到 assistant 消息 → push 到 `assistantMessages`；`filter(content => content.type === 'tool_use')` 得到 `msgToolUseBlocks`；非空则 `needsFollowUp = true`（**唯一的"还要再来一轮"信号**，注释见 query.ts:775-778：`stop_reason === 'tool_use'` 不可靠）。
- 若开启流式执行门控（`config.gates.streamingToolExecution`，query.ts:782-789），块会同时喂给 `StreamingToolExecutor.addTool`（query.ts:1129-1131），让工具在模型还在输出时就开始跑；否则统一在流结束后批量执行。

## 3. 调度：并发还是串行

`src/services/tools/toolOrchestration.ts`

- `:106 partitionToolCalls`：用 `tool.isConcurrencySafe(parsedInput)` 切批；连续只读的合并成一批并发，非只读单独一批串行。
- `:169 runToolsConcurrently`：并发上限 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`，默认 10（`:9-13`）。
- `:133 runToolsSerially`：串行，逐个 `runToolUse`，并用 `setInProgressToolUseIDs` 维护 UI 的进行中状态（`:142-165`）。

## 4. 单个工具：runToolUse → checkPermissionsAndCallTool

`src/services/tools/toolExecution.ts`

| 步骤 | 位置 | 说明 |
|---|---|---|
| 找工具 | `:374` | `findToolByName`；找不到 → `:427-434` 直接返回 `is_error: true` 的 `<tool_use_error>No such tool available: X</tool_use_error>` |
| 流式包装 | `:521` | `streamedCheckPermissionsAndCallTool`（边执行边产出进度/结果） |
| 参数校验 | `:657` / `:725` | `inputSchema.safeParse` → `tool.validateInput`；失败 → `:700-717` `is_error` 的 `InputValidationError` |
| PreToolUse hooks | `:840` | hook 可改写 input、阻止继续（`shouldPreventContinuation`） |
| 权限 | `:963` → `toolHooks.ts:340` → `permissions.ts:1141` | 最终落到 `tool.checkPermissions()` |
| 拒绝 | `:1037` / `:1072-1079` | 生成 `is_error: true` 的 tool_result（或 PreToolUse 的 stop 文案） |
| 执行 | `:1256-1286` | `tool.call(callInput, {...ctx, toolUseId, userModified}, canUseTool, assistantMessage, onProgress)` |
| 结果映射 | `:1367` | `tool.mapToolResultToToolResultBlockParam(result.data, toolUseID)` |
| 落盘/截断 | `:1484-1490` | `processPreMappedToolResultBlock` / `processToolResultBlock`，阈值取 `min(tool.maxResultSizeChars, 50_000)`（`src/utils/toolResultStorage.ts:55-78`、`src/constants/toolLimits.ts:13`）；另有 query.ts:588 `applyToolResultBudget` 做整轮预算 |
| 组装消息 | `:1531-1548` | `createUserMessage({ content: [toolResultBlock, ...acceptFeedback, ...images], toolUseResult, sourceToolAssistantUUID })` |
| PostToolUse hooks | `:1472` 起 | 可改写/追加输出，再交给 `addToolResult` |

## 5. WebFetch 在这条链路上的落点

- 权限：`packages/builtin-tools/src/tools/WebFetchTool/WebFetchTool.ts:106-182` —— 先查 `isPreapprovedHost`，再按 `domain:<hostname>` 查 deny/ask/allow 规则，**默认 `ask`**（弹权限框）。
- 执行：`WebFetchTool.ts:210 call()`
  - `:217-218` 后端选择：`settings.webFetchAdapter ?? 'tavily'`（默认 Tavily）。
  - `:222` `fetchContentWithTavily()`（`utils.ts:445`）：直接拿 Markdown；空内容会 **throw**（`utils.ts:524-528`）。
  - `:253-264` 只要传了 `prompt`，就把正文交给 `applyPromptToMarkdown()`（`utils.ts:543`）做**二级模型总结**。
  - `:368-374` `mapToolResultToToolResultBlockParam`：返回 `{ type:'tool_result', content: result }`（**不带 `is_error`**）。
- 声明 `maxResultSizeChars: 100_000`（`WebFetchTool.ts:72`）；`shouldDefer: true`（`:73`）。

## 6. 回注与下一轮

- `src/query.ts:1707-1731`：遍历 `runTools` 的 update，`update.message` 直接 yield（UI/SDK 可见），并按 `normalizeMessagesForAPI(...).filter(type === 'user')` 收进 `toolResults`。
- `src/query.ts:2081-2093`：下一轮 `state.messages = messagesForQuery.concat(assistantMessages, toolResults)`，`turnCount + 1`。
- 终止条件：`needsFollowUp === false`（query.ts:1379）、abort（`:1332` / `:1817`）、hook 阻止（`:1851`）、`maxTurns`（`:2071`）、`max_output_tokens` 恢复失败等。
- 中断兜底：`query.ts:150 yieldMissingToolResultBlocks()` —— 若已吐出 tool_use 却没结果，补 `is_error: true` 的 tool_result，避免 API 报 "tool_result 缺失"。

## 7. 与本轮问题相关的一句话

工具确实执行成功了；但 WebFetch 的最终文本不是网页原文，而是**二级模型总结后的文本**。若二级模型没吐出 text 块，`applyPromptToMarkdown` 会返回兜底串 `'No response from model'`（`WebFetchTool/utils.ts:592`），且该串作为**成功结果**回传 —— 详见 `packages/builtin-tools/src/tools/WebFetchTool/utils.md`。

## 8. query 的输出如何显示到前端

> 问题：`query()`（`src/query.ts:277`）是一个 AsyncGenerator，产出 `Message` / `StreamEvent` / `TombstoneMessage` / `ToolUseSummaryMessage` / `RequestStartEvent`，这些输出是怎么变成终端上的文字的？

### 结论

`query()` 本身**不渲染任何东西**，它只逐个 `yield` 事件。真正「显示到前端」的是**消费它的上层代码**，按运行模式分两条路径：

| 路径 | 消费方 | 输出目标 |
|---|---|---|
| A. REPL（交互式终端） | `src/screens/REPL.tsx` | React/Ink 组件树（`<Messages>`） |
| B. SDK / headless / -p | `src/QueryEngine.ts` | stdout 的 stream-json（桌面应用/CCR 消费） |

### 路径 A：REPL（React/Ink）

完整调用链（文件:行号）：

```text
query() 产出 event
  └─ REPL.tsx:3569   onQueryImpl 里 for await (const event of query({...}))
       └─ REPL.tsx:3579   onQueryEvent(event)
            └─ REPL.tsx:3185   handleMessageFromStream(event, 回调们)
                 └─ src/utils/messages.ts:3288  按 event 类型分类：
                      ├─ 完整消息(assistant/user/progress/attachment/system)
                      │     → onMessage(message)   [REPL.tsx:3347]
                      ├─ tombstone → onTombstone() [删除消息]
                      └─ stream_event(增量) → 按 content_block delta 处理
                            ├─ text_delta      → onUpdateLength + onStreamingText(打字机)
                            ├─ tool_use start  → onStreamingToolUses(流式工具输入)
                            └─ message_stop    → onSetStreamMode 切 spinner
       └─ REPL.tsx:3259   setMessages(old => [...old, newMessage])
            └─ REPL.tsx:1519   messages state (useState，ref 为真相源)
                 └─ REPL.tsx:5678   displayedMessages（流式时用 messages，否则用 deferredMessages）
                      └─ REPL.tsx:5976   <Messages messages={displayedMessages} .../>
                           └─ src/components/Messages.tsx 按 message.type 渲染 MessageRow
```

关键点：

- `query()` 产出的 `stream_event` 是**底层 API 的增量事件**（`text_delta`、`input_json_delta`、`thinking_delta` 等），用于「打字机」式流式显示；完整 `Message`（assistant/user）是**组装好的整条消息**。
- `handleMessageFromStream`（`messages.ts:3288`）把这两类事件统一成一组回调：`onMessage`（append 完整消息）、`onUpdateLength`（响应长度/spinner）、`onStreamingText`（流式文本）、`onStreamingToolUses`（流式工具输入）、`onTombstone`（删除）。
- `setMessages`（`REPL.tsx:1535`）用 Zustand 模式：`messagesRef` 是真相源、React state 是渲染投影，保证流式高频 append 时不会读到 stale 值。
- `displayedMessages`（`REPL.tsx:5678`）：`usesSyncMessages` 为真（正在流式/loading）时直接取 `messages`，否则取 `useDeferredValue` 的 `deferredMessages`（降优先级渲染，保证输入流畅）。

### 路径 B：SDK / headless / -p

- `QueryEngine.submitMessage`（`src/QueryEngine.ts:217`）在 `:688` 处 `for await (const message of query({...}))`。
- 用 `switch (message.type)` 把每种 Message 转换成 SDK 协议消息：
  - `assistant/user/progress/attachment` → `yield* normalizeMessage(msg)`（`:789/:804/:810`）
  - `stream_event` → `includePartialMessages` 时才透传（`:850`）
  - `system` → compact_boundary / api_retry（`:939` 起）
  - 最终 `result` 消息（`:1194`）收尾
- 这些 `SDKMessage` 由上游（`ask()`/`print.ts`/`AcpAgent.ts`）以 **stream-json** 写到 stdout，供桌面应用（cowork/CCR）、ACP 客户端消费，无终端 UI。

### 两条路径的差异

- REPL 用 `handleMessageFromStream` 把 `stream_event` 翻译成 UI 状态（流式文本、spinner、流式工具输入）；SDK 路径基本只透传 `Message`（`stream_event` 默认不透传，除非 `includePartialMessages`）。
- REPL 的目标是 `messages` state → React 组件；SDK 的目标是 `SDKMessage` → stdout 协议。

## 9. 技术架构图与事件定义/捕捉

### 9.1 分层架构

```text
┌────────────────────────────────────────────────────────────────┐
│ 前端显示层 (UI)                                                  │
│   REPL.tsx / <Messages>(React/Ink)      │  SDK: stdout stream-json │
└───────────────────────┬────────────────────────────────────────┘
                        │ setMessages / yield SDKMessage
┌───────────────────────▼────────────────────────────────────────┐
│ 编排层 (Orchestration)                                          │
│   query.ts (AsyncGenerator，turn 循环)                           │
│   QueryEngine.ts (SDK 包装) · toolOrchestration.ts (工具调度)    │
└───────────────────────┬────────────────────────────────────────┘
                        │ StreamEvent / Message
┌───────────────────────▼────────────────────────────────────────┐
│ API 客户端层                                                     │
│   claude.ts stream() —— 捕捉 SDK 事件，透传 + 组装完整消息        │
│   openaiStreamAdapter / gemini streamAdapter —— 归一化成同格式    │
└───────────────────────┬────────────────────────────────────────┘
                        │ BetaRawMessageStreamEvent
┌───────────────────────▼────────────────────────────────────────┐
│ 网络层 (Anthropic SDK / SSE)                                     │
└─────────────────────────────────────────────────────────────────┘
```

### 9.2 事件定义

真正定义在 `packages/@ant/model-provider/src/types/message.ts`，`src/types/message.ts` 只是 re-export：

| 类型 | 定义 | 说明 |
|---|---|---|
| `StreamEvent` | `{ type: string; [k: string]: unknown }`（`:81`） | 运行时 `type === 'stream_event'`，携带 `event`（底层原始事件）+ 可选 `ttftMs` |
| `RequestStartEvent` | `{ type: string; ... }`（`:80`） | 请求开始信号，`type === 'stream_request_start'` |
| `Message`（层次） | `AssistantMessage`/`UserMessage`/`ProgressMessage`/`AttachmentMessage`/`SystemMessage` | 完整消息 |
| `TombstoneMessage` | `= Message`（`:94`） | 删除信号，消费端据此移除消息 |
| `ToolUseSummaryMessage` | `= Message`（`:95`） | 工具调用摘要（SDK-only） |

`query()` 的 `AsyncGenerator` 泛型（`src/query.ts:277-286`）就是这几类的并集。

### 9.3 事件捕捉（claude.ts stream()）

核心在 `src/services/api/claude.ts` 的 stream 函数（`:788`，`AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage>`）：

1. `:1887` 拿到 SDK 的 `Stream<BetaRawMessageStreamEvent>`。
2. `for await (const part of stream)` 消费，`switch (part.type)` 处理：
   - `message_start`（`:2020`）→ 记录 `ttftMs`、初始 usage
   - `content_block_start`（`:2043`）→ 初始化 `contentBlocks[index]`（tool_use 的 `input=''`、text 的 `text=''`、thinking 的 `thinking=''`）
   - `content_block_delta`（`:2106`）→ 累积增量（`input_json_delta` 拼 JSON、`text_delta` 推入 `textDeltas`、`thinking_delta` 拼 thinking、`signature_delta` 存签名）
   - `content_block_stop`（`:2227`）→ 合并 text deltas，**组装完整 `AssistantMessage` 并 `yield`**（`:2254-2290`）
   - `message_delta`（`:2293`）→ 用**直接 mutation** 把最终 `usage`/`stop_reason` 回写到已 yield 的最后一条消息（`:2328-2332`）
   - `message_stop`（`:2382`）→ 收尾
3. **每个 part 末尾都 `yield { type: 'stream_event', event: part, ...ttftMs }`**（`:2387`）——这是关键：底层事件原样透传给 query 层，供上层做打字机式流式显示。

> 兼容层（OpenAI/Gemini）通过 `adaptOpenAIStreamToAnthropic` / `adaptGeminiStreamToAnthropic` 把第三方 SSE 归一化成同样的 `BetaRawMessageStreamEvent`，所以下游 claude.ts 完全无感知。

### 9.4 完整执行过程（一次 assistant 回复）

```text
用户提交
  └─ handlePromptSubmit → executeUserInput → onQuery (REPL.tsx:3676)
       └─ onQueryImpl: for await query({...})  (REPL.tsx:3569)
            └─ query() while(true) turn 循环
                 └─ 调 claude.ts stream()
                      └─ for await SDK stream:
                           ├─ yield stream_event (透传, :2387)
                           └─ content_block_stop → yield AssistantMessage (:2290)
                 └─ 收到 assistant → 若有 tool_use → runTools (toolOrchestration)
            └─ 每个 event → onQueryEvent → handleMessageFromStream
                 └─ setMessages → <Messages> 渲染
```

### 9.5 Hello World

可运行的自包含示例见项目根目录 `hello-world-event-stream.ts`：

```bash
bun hello-world-event-stream.ts
# 打字机流式输出: Hello, world!
# [Messages 渲染] 当前 1 条完整消息:
#   · assistant: "Hello, world!"
```

它复刻了「事件定义 → 捕捉(生成器) → 透传(stream_event) → 组装(assistant) → 消费(handleMessageFromStream) → 状态(setMessages) → 渲染(render)」的完整管道，每个环节都标注了真实源码位置。

## 附录：坏味道清单（2026-11-22，对应 specs/003-refactor-query-engine）

### A. 结构

1. **单函数 1670 行、隐式状态机**：`queryLoop` 从 `query.ts:407` 到 `query.ts:2076`，整个文件只有一个 `while (true)` 循环体。终止靠 `return { reason }`，继续靠 `state = next; continue`。
2. **7 个 continue 站点各手写 9 字段 `State` 字面量**：`query.ts:1397`、`1450`、`1505`、`1529`、`1584`、`1622`、`2062`。新增一个跨迭代字段必须同时改 7 处，漏一处即静默丢状态（`pendingToolUseSummary`、`stopHookActive` 在最年轻的两处就被显式重置为 `undefined`）。
3. **一个函数混装 9 个阶段**：输入瘦身（`query.ts:563`）、工具结果预算（`588`）、snip（`610`）、microcompact（`623`）、context collapse（`659`）、autocompact（`674`）、预测式 autocompact（`875`）、采样（`928`）、工具执行（`1684`）、附件注入（`1913`）、turn 计数（`2027`）。
4. **`messagesForQuery` 一个变量 9 种语义**：`query.ts:544/563/588/613/628/665/756/898/1197` 依次变成「原始 → 去 toolUseResult → 过预算 → 过 snip → 过 microcompact → 过 collapse → post-compact → 换模型后再瘦身」。读者必须记住当前走到第几步。
5. **两套并行消息数组**：`messagesForQuery`（API 视角）与 `state.messages`（UI/存储视角）无类型区分，只能靠 `query.ts:544` 的注释区分。

### B. 重复

6. **「重置本轮收集器 + 重建 StreamingToolExecutor」重复两遍**：`query.ts:990-1014` 与 `query.ts:1169-1188`，代码几乎逐行相同，但一处由 `streamingFallbackOccured` 触发、一处由 `FallbackTriggeredError` 触发。
7. **「抽 tool_use 块」重复 4 遍**：`query.ts:154-162`、`1122-1128`、`1230-1235`、`1733-1740`，写法都是 `Array.isArray(content) ? content : []` + `filter(c => c.type === 'tool_use')` + 断言。缺一个 `getToolUseBlocks(msg)`。
8. **`withheld` 由 4 段独立 `if` 累加**：`query.ts:1091-1114`（collapse / reactive / media / max_output_tokens），每段挂不同 feature gate，无法一眼看出互斥关系。
9. **埋点样板击穿逻辑**：`learningLog` 18 次、`logEvent` 8 次、`queryCheckpoint` 15 次。其中 `logEvent` 每条都要手写 `queryChainId`/`queryDepth` 两个字段（`query.ts:721`、`1237`、`1652`、`1843`、`1856`、`2003`）。

### C. 死代码 / 可疑

10. **`pendingCacheEdits` 计算后从未使用**：`query.ts:642-644`，`CACHED_MICROCOMPACT` 开启时算出来就丢了。
11. **恒真三元**：`query.ts:902-908` 写成 `tracking = tracking ? {...} : tracking`。
12. **原地变异破坏「State 不可变」契约**：`query.ts:1837` 直接 `tracking.turnCounter++`；`query.ts:1191` 直接改共享对象 `toolUseContext.options.mainLoopModel = fallbackModel`。
13. **调试残留**：`query.ts:545` 行尾裸挂 `// messagesForQuery=[object Object],[object Object]`；`query.ts:1023` 留了一整行打印出来的消息 JSON。

### D. 注释与命名

14. **注释指向行号**：`query.ts:657`（`query.ts:1192`）、`query.ts:739`（`autoCompact.ts:190`）。
15. **注释指向本仓库不存在的路径**：`query.ts:458` 引用 `api/api/sampling/prompt/renderer.py:292`。
16. **中英混排**：`query.ts:323`、`1271-1272` 是中文，其余全英文注释；同一文件两套语言。
17. **短名与遮蔽**：`msg` / `_` / `_sel` / `_filter`（`QueryEngine.ts:476`、`654-656`）；`query.ts:484` `let { toolUseContext } = state` 后再同名重新赋值；`updatedToolUseContext`（`query.ts:1662`）与 `toolUseContext` 并存，读者要自己判断谁是最新值。
