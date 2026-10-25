---
name: learning-trace-log
overview: 在「命令行 → REPL → query → claude.ts 模型流式调用」这条交互链路上，新增带 `[learning]` 前缀的分阶段日志，默认常开写入 ~/.claude/debug/learning-*.log（并维护 latest 软链），用 tail -f 观察，不污染终端。
todos:
  - id: add-learning-log-util
    content: 新建 src/utils/learningLog.ts，实现格式化、缓冲写盘与 latest 软链
    status: completed
  - id: instrument-entry
    content: 在 cli.tsx 与 main.tsx 埋 CLI 启动、会话模式、进入 REPL 日志
    status: completed
    dependencies:
      - add-learning-log-util
  - id: instrument-repl
    content: 在 REPL.tsx 埋提交、onQuery、query 循环与助手消息渲染日志
    status: completed
    dependencies:
      - add-learning-log-util
  - id: instrument-query
    content: 在 query.ts 埋 query 入口、callModel、工具执行与 outcome 日志
    status: completed
    dependencies:
      - add-learning-log-util
  - id: instrument-api
    content: 在 claude.ts 埋请求参数、HTTP 发送、SSE 各事件与非流式降级日志
    status: completed
    dependencies:
      - add-learning-log-util
  - id: verify-logging
    content: 跑 typecheck、lint、bun test 并用 bun run dev 验证全链路日志
    status: completed
    dependencies:
      - instrument-entry
      - instrument-repl
      - instrument-query
      - instrument-api
---

## 用户需求

用户希望沿着"命令行输入 → 交互 REPL → query 编排 → 最终模型流式输出"这条完整执行链路打日志，每行日志带 `learning` 前缀（形如 `[learning]`），目的是学习并理解 Claude Code 逆向工程仓库的主执行链路。

## 产品概述

在现有交互模式下新增一套**阶段化链路追踪日志**，把一次对话请求从进程启动、命令解析、用户提交消息、System Prompt 组装、工具表组装、HTTP 请求发出、SSE 流式事件（message_start / content_block / tool_use / text delta / message_delta / message_stop）、工具回填与再入模型，直到 assistant 消息渲染完毕的全过程，按阶段打点记录下来。

## 核心功能

- **阶段化打点**：CLI 启动 → 会话模式判定 → REPL 提交 → query 编排 → 模型 HTTP 请求 → SSE 流事件 → 工具执行与回填 → 助手消息输出，每个阶段一条日志。
- **统一前缀**：所有日志行以 `[learning]` 开头，附相对启动耗时（如 `+1234ms`）、阶段名与关键字段（model、messages 数、tools 数、stop_reason、usage、ttft、request_id、工具名等）。
- **文件输出不污染终端**：默认常开，始终写入 `~/.claude/debug/learning-<时间戳>.log`，并维护 `learning-latest.log` 软链便于 `tail -f`；不写 stdout/stderr，不影响 Ink TUI 与 `-p` 的 stream-json 输出。
- **安全边界**：超长内容（prompt、消息正文）只打印长度或截断到 200 字符；测试环境自动静默。
- **范围限定**：仅覆盖交互 REPL 链路（`REPL.tsx → query.ts → claude.ts`），不改动 `-p`/print 与 QueryEngine 那条打印链路。

## 技术栈

- 运行时 Bun + TypeScript strict（`bunx tsc --noEmit` 必须零错误）
- 代码规范 Biome（`bun run lint` / `lint:fix`）
- 测试 `bun test`（bun:test）
- 复用仓库现有基建：`src/utils/bufferedWriter.js` 的 `createBufferedWriter`、`src/utils/cleanupRegistry.js` 的 `registerCleanup`、`src/utils/envUtils.js` 的 `getClaudeConfigHomeDir` / `isEnvTruthy`

## 实现方案

新增一个**零副作用依赖**的独立日志模块 `src/utils/learningLog.ts`，在链路关键点以单行调用埋点。之所以不复用 `logForDebugging`（`src/utils/debug.ts:214`）：它有 `shouldLogDebugMessage` 门禁（非 ant 用户未开 `--debug` 时不落盘），且依赖 `src/bootstrap/state.ts`（模块级 `realpathSync`/`randomUUID` 副作用），会给测试带来强制 mock 负担。

关键决策：

1. **独立于 debug 体系**：`learningLog.ts` 只依赖 `fs`、`path`、`bufferedWriter`、`envUtils`、`cleanupRegistry`，不触碰 `log.ts` / `debug.ts` / `bootstrap/state.ts`，避免扩大副作用面与测试 mock 面。
2. **缓冲写 + 定期 flush**：SSE delta 是热路径，不能每事件同步写盘。统一走 `createBufferedWriter`（`flushIntervalMs: 200`、`maxBufferSize: 256`），并用 `registerCleanup` 在进程退出前 flush。同时对 delta 类事件**只做计数聚合**（每轮合并成一行 `content_block_stop` 摘要），不逐 delta 打日志。
3. **测试静默**：`process.env.NODE_ENV === 'test'` 时直接返回（对齐 `debug.ts:103` 的既有约定），保证 `bun test` 不产生文件与句柄泄漏。
4. **输出通道**：仅文件（用户选定）。`CLAUDE_CODE_LEARNING_LOG_FILE` 可覆盖路径；`CLAUDE_CODE_LEARNING_LOG=off|0` 可关闭；`latest` 软链沿用 `debug.ts:255` 的 `unlink + symlink` 写法。

## 架构设计

一次交互回合的日志流向：

```mermaid
flowchart TD
  A[cli.tsx: main 启动 / argv] --> B[main.tsx: 会话模式判定 / 进入 REPL]
  B --> C[REPL.tsx: onSubmit → onQuery → onQueryImpl]
  C --> D[REPL.tsx:3513 for await query()]
  D --> E[query.ts:276 query → queryLoop]
  E --> F[query.ts:899 deps.callModel]
  F --> G[claude.ts:774 queryModelWithStreaming → 1048 queryModel]
  G --> H[claude.ts:1893 paramsFromContext → 1917 HTTP create]
  H --> I[claude.ts:2036 SSE 事件循环]
  I --> J[message_start / content_block_start / delta 聚合 / stop / message_delta / message_stop]
  J --> K[query.ts:1671 runTools 工具执行]
  K --> L[工具结果回填 → 下一轮 F]
  L --> E
  J --> M[REPL.tsx:3522 onQueryEvent → 渲染 assistant 消息]
  A -.-> N[learningLog.ts 缓冲写 → ~/.claude/debug/learning-*.log]
  B -.-> N
  C -.-> N
  E -.-> N
  G -.-> N
  I -.-> N
  K -.-> N
  M -.-> N
```

## 目录结构

```
src/
├── utils/
│   └── learningLog.ts              # [NEW] learning 链路日志工具。导出 learningLog(stage, fields?) 与 getLearningLogPath()。
│                                   #   职责：开关判定（NODE_ENV=test 静默、CLAUDE_CODE_LEARNING_LOG=off 关闭）、
│                                   #   单行格式化（"[learning] +1234ms <stage> k=v k=v"）、字段截断（>200 字符截断到长度+摘要）、
│                                   #   目标文件路径解析（环境变量覆盖 → ~/.claude/debug/learning-<YYYYMMDD-HHmmss>.log）、
│                                   #   基于 createBufferedWriter 的懒初始化写盘 + registerCleanup 退出 flush、
│                                   #   维护 ~/.claude/debug/learning-latest.log 软链（参考 debug.ts:255 的 unlink+symlink 写法）。
│                                   #   必须零副作用依赖：仅 fs/fs.promises、path、./bufferedWriter.js、./envUtils.js、
│                                   #   ./cleanupRegistry.js；禁止 import log.ts / debug.ts / bootstrap/state.ts。
├── entrypoints/
│   └── cli.tsx                     # [MODIFY] 第 77 行取 argv 后打点 cli.startup（argv 截断）；第 353-359 行默认路径
│                                   #   打点 cli.load_main_module（before/after import）与 cli.main_complete。
├── main.tsx                        # [MODIFY] 第 965-977 行打点 main.session_mode { isInteractive, hasPrintFlag, isTTY }；
│                                   #   第 1434 行 action 入口打点 main.action { model, hasPrompt }；
│                                   #   第 2749-2760 行交互分支打点 main.enter_repl（渲染 REPL 之前）。
├── screens/
│   └── REPL.tsx                    # [MODIFY] 第 3970 行 onSubmit 打点 repl.submit（输入类型/长度，正文截断）；
│                                   #   第 3334 行 onQueryImpl 入口打点 repl.on_query { messages, shouldQuery, model }；
│                                   #   第 3506 行后打点 repl.context_ready（systemPrompt 字符数、tools 数量）；
│                                   #   第 3513 行 query 调用前打点 repl.query_start，第 3539 行循环结束后打点 repl.query_end；
│                                   #   第 3152 行 onQueryEvent 内对 assistant 消息打点 repl.assistant_message（文本长度、stop_reason、
│                                   #   tool_use 数），只在消息级事件上打，不在每个 stream_event 上打。
├── query.ts                        # [MODIFY] 第 276 行 query 入口打点 query.start { messageCount, querySource, toolCount }；
│                                   #   第 899 行 deps.callModel 前打点 query.call_model { model, messages, tools, attempt }；
│                                   #   第 1671 行 runTools 打点 query.tool_exec { tools: 工具名列表 }；
│                                   #   第 1673 行循环后打点 query.tool_results { count, errored }；
│                                   #   第 331-332 行返回前打点 query.outcome { didThrow, terminal, commands }。
└── services/api/
    └── claude.ts                   # [MODIFY] 第 1048 行 queryModel 入口打点 api.query_model { model, messages, tools }；
                                    #   第 1893 行 params 就绪后打点 api.request_params { model, max_tokens, systemBlocks, tools, betas,
                                    #   temperature, thinking }（不打印 messages 正文）；
                                    #   第 1917 行发送前打点 api.http_request_sent，第 1928-1930 行打点 api.response_headers
                                    #   { status, requestId }（status 从 result.response 取）；
                                    #   第 2065 行 first chunk 打点 api.first_chunk；
                                    #   第 2076 行 message_start 打点 api.message_start { ttftMs, inputTokens, cacheRead, cacheCreation }；
                                    #   第 2093 行 content_block_start/tool_use 打点 api.tool_use { name, id }；
                                    #   第 2270-2316 行 content_block_stop 打点 api.content_block_stop { type, chars, toolName }（delta 只计数聚合）；
                                    #   第 2319 行 message_delta 打点 api.message_delta { stopReason, outputTokens }；
                                    #   第 2404 行 message_stop 打点 api.message_stop { totalDeltaEvents }；
                                    #   第 2419 行 streamIdleAborted 分支打点 api.stream_idle_abort，第 2688/2788 行非流式降级打点
                                    #   api.fallback_nonstreaming。
```

## 关键代码结构

```ts
// src/utils/learningLog.ts —— 唯一对外契约（无实现体，供实现参考）
/** 阶段名约定：`cli.*` / `main.*` / `repl.*` / `query.*` / `api.*` 五段式，便于 grep 顺序还原链路 */
export type LearningStage = string

/**
 * 记录一行 learning 链路日志（默认常开；NODE_ENV=test 或 CLAUDE_CODE_LEARNING_LOG=off|0 时静默）。
 * 输出形如：[learning] +1234ms 2026-10-25T12:00:00.000Z repl.query_start model=claude-x messages=12 tools=58
 * fields 中的字符串超 200 字符自动截断为 `<N chars>`；undefined/null 字段被忽略。
 */
export function learningLog(stage: LearningStage, fields?: Record<string, unknown>): void

/** 当前会话日志文件的绝对路径（懒创建，供启动/排障打印） */
export function getLearningLogPath(): string
```

## 实施要点（防回归）

- **性能**：`claude.ts:2150` 的 content_block_delta 是每 token 触发的热路径，此处**只做计数器自增**，日志在 `content_block_stop`（2270 行）合并输出一行；`query.ts:1673` 的工具结果循环同理用一次性摘要，避免日志本身成为吞吐瓶颈。
- **隐私/体积**：禁止打印 system prompt 全文、messages 正文、工具入参原文；统一记录长度与截断摘要（200 字符上限）。
- **兼容性**：不修改任何现有逻辑分支与返回值；每处埋点控制在 1-3 行；不引入新的 feature flag、不改 `--debug` 行为。
- **测试**：因为 `NODE_ENV=test` 静默，现有 200+ 单测不受影响；不要让任何生产模块把 learningLog 作为必需依赖进行断言。
- **验收**：`bun run typecheck` 零错误（严格模式、禁止 `as any`）；`bun run lint:fix`；`bun test` 无新增失败；本地 `bun run dev` 起交互式会话，另开终端 `tail -f ~/.claude/debug/learning-latest.log` 能按时间顺序看到 `cli → main → repl → query → api` 全链路，一轮含工具调用的请求能看到 tool_exec 与第二轮 api 请求。
- **注意**：`getLearningLogPath` 的目标目录需 `mkdir -p`（复用 bufferedWriter 的 writeFn 内首次 mkdir，避免模块加载时即产生 IO 副作用）。