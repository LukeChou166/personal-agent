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
