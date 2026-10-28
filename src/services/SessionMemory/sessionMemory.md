# sessionMemory.ts 执行机制（querySource = `session_memory`）

Session Memory 用后台 fork 子代理维护一份「当前会话笔记」markdown 文件，不打断主对话。

- 源文件：`src/services/SessionMemory/sessionMemory.ts`
- 配置/阈值：`src/services/SessionMemory/sessionMemoryUtils.ts`
- Prompt：`src/services/SessionMemory/prompts.ts`

## 一、注册入口

`initSessionMemory()`（`src/services/SessionMemory/sessionMemory.ts:364`）在启动时被同步调用：

- 调用点：`src/setup.ts:298`（`if (!isBareMode())` 分支内，与 `initSkillLearning()` 并列）
- 前置条件：`getIsRemoteMode()` 为真直接返回（`sessionMemory.ts:365`）；`isAutoCompactEnabled()` 为假直接返回（`sessionMemory.ts:376`）——session memory 服务于压缩，所以跟随 auto-compact 开关
- 只做一件事：`registerPostSamplingHook(extractSessionMemory)`（`sessionMemory.ts:381`）。Gate 与远程配置都在 hook 真正跑的时候惰性加载，避免启动阻塞。

## 二、触发链路

```
REPL 主线程 query()  ← querySource: 'repl_main_thread'
  └─ src/query.ts:1317-1326  void executePostSamplingHooks(...)  // fire-and-forget，每轮采样后都触发
       └─ src/utils/hooks/postSamplingHooks.ts:45  executePostSamplingHooks()
            └─ sessionMemory.ts:273  extractSessionMemory(context)
                 └─ src/utils/forkedAgent.ts:508  runForkedAgent({ querySource: 'session_memory', ... })
                      └─ src/query.ts  query({ querySource: 'session_memory' })
```

`REPLHookContext`（`src/utils/hooks/postSamplingHooks.ts:11`）携带 `messages / systemPrompt / userContext / systemContext / toolUseContext / querySource`。

## 三、extractSessionMemory 的层层过滤

`sessionMemory.ts:273-357`，被 `sequential()` 包裹（串行，防并发重叠）：

1. **只跑主线程**：`querySource !== 'repl_main_thread'` 直接 return（`sessionMemory.ts:279-282`）。子代理/teammate 不跑。
2. **穷鬼模式**：`feature('POOR')` 下 `isPoorModeActive()` 为真则 return（`sessionMemory.ts:285-288`）。
3. **GrowthBook gate**：`tengu_session_memory`（`sessionMemory.ts:81`、`291-298`），用 `getFeatureValue_CACHED_MAY_BE_STALE`，非阻塞读磁盘缓存。
4. **远程配置**：`tengu_sm_config`，`memoize` 只初始化一次（`sessionMemory.ts:241-265`）。默认值（`sessionMemoryUtils.ts:32`）：`minimumMessageTokensToInit=10000`、`minimumTokensBetweenUpdate=5000`、`toolCallsBetweenUpdates=3`。
5. **阈值判断** `shouldExtractMemory()`（`sessionMemory.ts:135-182`）：
   - 未初始化则先要求上下文 ≥ `minimumMessageTokensToInit`，满足后 `markSessionMemoryInitialized()`
   - 必须满足 token 增长阈值（`hasMetUpdateThreshold`，与上次抽取时的差值 ≥ `minimumTokensBetweenUpdate`，`sessionMemoryUtils.ts:184`）
   - 触发条件：`(token阈值 && 工具调用数阈值)` **或** `(token阈值 && 最后一轮 assistant 无工具调用)`
   - token 阈值是**必要条件**，单独满足工具调用次数不会触发

## 四、执行体（fork 子代理）

1. `markExtractionStarted()`（`sessionMemory.ts:307`）
2. `createSubagentContext(toolUseContext)` 建隔离上下文（`sessionMemory.ts:310` → `src/utils/forkedAgent.ts:342`）
3. `setupSessionMemoryFile()`（`sessionMemory.ts:184-234`）：`mkdir` 0700 目录 → 用 `wx` flag 创建笔记文件（已存在则忽略 EEXIST）→ 写入模板（`prompts.ts:13-43`，可用 `~/.claude/session-memory/config/template.md` 覆盖）→ 删掉 `readFileState` 缓存后调 `FileReadTool.call` 读真实内容
4. `buildSessionMemoryUpdatePrompt(currentMemory, memoryPath)`（`prompts.ts:226`）：模板来自 `~/.claude/session-memory/config/prompt.md`，否则用默认更新指令；会按段（每节 ≤2000 token，总量 ≤12000 token）追加压缩提醒
5. `runForkedAgent({ querySource: 'session_memory', forkLabel: 'session_memory', canUseTool: createMemoryFileCanUseTool(memoryPath), overrides: { readFileState } })`（`sessionMemory.ts:325-332`）
6. 收尾：`logEvent('tengu_session_memory_extraction')`（`sessionMemory.ts:339`）、`recordExtractionTokenCount()`（`:351`）、`updateLastSummarizedMessageIdIfSafe()`（`:354`）、`markExtractionCompleted()`（`:356`）

## 五、权限边界

`createMemoryFileCanUseTool(memoryPath)`（`sessionMemory.ts:467-489`）：**只允许 `FileEditTool` 且 `file_path` 严格等于该笔记文件路径**，其余全部 deny。所以这个 fork 本质上只能 Edit 那一个文件。

## 六、runForkedAgent 里发生了什么

`src/utils/forkedAgent.ts:508`：

- `createSubagentContext()` 隔离可变状态（克隆 `readFileState`、新建子 `abortController`、`setAppState` 变 no-op 等，`forkedAgent.ts:342-463`）
- `initialMessages = [...forkContextMessages, ...promptMessages]`（`forkedAgent.ts:543`）——父会话完整历史 + 抽取指令，**这是共享父级 prompt cache 的关键**
- 默认会记录 sidechain transcript（`forkedAgent.ts:547-560`）；session memory 未设 `skipTranscript`，故有 transcript
- `for await (const message of query({ ..., querySource, maxTurns, skipCacheWrite }))`（`forkedAgent.ts:564-575`），从 `message_delta` 累积 usage
- 结束后 `logForkAgentQueryEvent` → `tengu_fork_agent_query`（`forkedAgent.ts:640-716`）

## 七、`session_memory` 作为 querySource 的特殊待遇

| 位置 | 行为 |
|------|------|
| `src/query.ts:851-852` | 跳过 `isAtBlockingLimit` 的 prompt-too-long 拦截（与 `compact` 一样），否则 fork 继承了完整会话会被自己卡死 |
| `src/query.ts:585-587` | 不匹配 `agent:` / `repl_main_thread` 前缀 → 不做 tool result 替换的持久化 |
| `src/services/api/claude.ts:1107-1112` | `isAgenticQuery=false`（只有 `repl_main_thread*`/`agent:*`/`sdk`/`hook_agent`/`verification_agent` 才是 agentic）→ beta header 集合不同 |
| `src/services/api/withRetry.ts:62-89` | 不在 `FOREGROUND_529_RETRY_SOURCES` 中 → 遇 529 **立即失败不重试** |
| `src/services/api/promptCacheBreakDetection.ts:143-147` | 属于「untracked sources」，不做 prompt cache break 检测 |
| `src/services/compact/microCompact.ts:276-280` | 注释明确：fork 类 source 不参与 cached microcompact，避免污染主线程全局状态 |

## 八、与压缩的关系

`src/services/compact/sessionMemoryCompact.ts:526-529` 在压缩前 `await waitForSessionMemoryExtraction()`（`sessionMemoryUtils.ts:89-105`，轮询 1s，15s 超时 / 60s 视为 stale 直接放弃），确保压缩时读到最新笔记。笔记还会经 `truncateSessionMemoryForCompact()`（`prompts.ts:260`）截断后再注入压缩消息。

## 九、手动触发（/summary）

`manuallyExtractSessionMemory()`（`sessionMemory.ts:394-460`）跳过所有阈值判断，自己构造 `cacheSafeParams`（`getSystemPrompt` + `getUserContext` + `getSystemContext`），`forkLabel` 用 `'session_memory_manual'`（`:438`），`querySource` 仍是 `'session_memory'`（`:437`）。
