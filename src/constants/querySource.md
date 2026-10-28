# QuerySource 与后台 fork 来源（`session_memory` / `extract_memories`）

定义：`src/constants/querySource.ts:6`

```ts
export type QuerySource = string // 与日志/统计中的 source 字段对齐的自由文本标签
```

用途：遥测拆分、缓存控制（1h TTL allowlist / prompt cache break 检测）、529 重试策略、agentic beta header 判定、工具结果替换持久化范围。

## 常见取值

| 值 | 来源 |
|----|------|
| `repl_main_thread`、`repl_main_thread:outputStyle:<style>` | `getQuerySourceForREPL()`，`src/utils/promptCategory.ts:36-49`（REPL 主线程，`src/screens/REPL.tsx:3158`/`3576`） |
| `sdk` | `src/QueryEngine.ts:437`、`696` |
| `agent:default` / `agent:builtin[:type]` / `agent:custom` | `src/utils/promptCategory.ts:22-27` |
| `compact` / `session_memory` / `extract_memories` / `prompt_suggestion` / `side_question` / `hook_agent` 等 | 各 fork 调用点 |

## `session_memory` 与 `extract_memories` 是什么

两者都不是用户可见的主查询，而是**后台 fork 子代理**的标签：由 `runForkedAgent()`（`src/utils/forkedAgent.ts:508`）发起，走与主线程完全相同的 `query()` 循环，但：

- 用 `createCacheSafeParams(context)`（`src/utils/forkedAgent.ts:126`）复用父级的 `systemPrompt / userContext / systemContext / toolUseContext / forkContextMessages`
- `initialMessages = [...forkContextMessages, ...promptMessages]`（`forkedAgent.ts:543`）——父会话历史作为前缀，从而命中父级 prompt cache
- 通过 `canUseTool` 把工具权限收到极小范围
- 结束时统一打点 `tengu_fork_agent_query`（`forkedAgent.ts:683`）

区别见：

- `src/services/SessionMemory/sessionMemory.md`
- `src/services/extractMemories/extractMemories.md`

## querySource 影响的下游行为

| 行为 | 位置 |
|------|------|
| 529 重试白名单（两个 source 均不在内 → 不重试） | `src/services/api/withRetry.ts:62-89` |
| `isAgenticQuery`（只有 `repl_main_thread*` / `agent:*` / `sdk` / `hook_agent` / `verification_agent` 为真） | `src/services/api/claude.ts:1107-1113` |
| 1h prompt cache TTL allowlist 匹配（前缀 `*` 通配） | `src/services/api/claude.ts:388-428` |
| prompt cache break 检测（untracked sources 跳过） | `src/services/api/promptCacheBreakDetection.ts:143-147` |
| prompt-too-long blocking 拦截跳过（`compact`、`session_memory`） | `src/query.ts:849-869` |
| tool result 替换持久化范围（`agent:` / `repl_main_thread` 前缀才持久化） | `src/query.ts:585-587` |
| cached microcompact（仅主线程） | `src/services/compact/microCompact.ts:276-280` |
| `saveCacheSafeParams` 快照（仅 `repl_main_thread` / `sdk`） | `src/query/stopHooks.ts:91-93` |
| 是否主线程（决定排队命令可见性） | `src/query.ts:1899-1900` |
