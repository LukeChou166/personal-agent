# extractMemories.ts 执行机制（querySource = `extract_memories`）

从会话转录里抽取「长期记忆」，写入 auto-memory 目录（`~/.claude/projects/<path>/memory/`）。同样用 fork 子代理，共享父级 prompt cache。

- 源文件：`src/services/extractMemories/extractMemories.ts`
- Prompt：`src/services/extractMemories/prompts.ts`
- 路径/开关：`src/memdir/paths.ts`

## 一、初始化

`initExtractMemories()`（`extractMemories.ts:293`）由 `src/utils/backgroundHousekeeping.ts:31-37` 在 `feature('EXTRACT_MEMORIES')` 下动态 import 后调用。所有可变状态（游标、重叠保护、pending 上下文）**闭包内**，不是模块级——这样测试可在 `beforeEach` 里重新 init 拿到干净闭包。

未 init 时 `executeExtractMemories` / `drainPendingExtraction` 都是 no-op（`extractMemories.ts:284-285`、`595-612`）。

## 二、触发链路

```
query loop 结束（模型产出无工具调用的最终回复）
  └─ src/query.ts:1587-1596  handleStopHooks(..., querySource, stopHookActive)
       └─ src/query/stopHooks.ts:79-86  组装 stopHookContext (REPLHookContext)
       └─ src/query/stopHooks.ts:143-162  条件满足 → void import(...).then(executeExtractMemories)  // fire-and-forget
            └─ extractMemories.ts:595  executeExtractMemories(context, appendSystemMessage)
                 └─ extractMemories.ts:326  runExtraction()
                      └─ src/utils/forkedAgent.ts:508  runForkedAgent({ querySource: 'extract_memories', ... })
                           └─ src/query.ts  query({ querySource: 'extract_memories' })
```

`handleStopHooks` 里的触发条件（`src/query/stopHooks.ts:135-162`）：

- `!isBareMode()`（`--bare`/SIMPLE 脚本化调用跳过全部后台记账）
- `feature('EXTRACT_MEMORIES')`
- `!toolUseContext.agentId`（不跑子代理）
- `isExtractModeActive()`（`src/memdir/paths.ts:69`：`tengu_passport_quail` gate + 非交互时还需 `tengu_slate_thimble`）
- `!poorMode`

## 三、executeExtractMemoriesImpl 的前置过滤

`extractMemories.ts:524-564`：

1. `context.toolUseContext.agentId` 存在 → return（只跑主 agent，`:529`）
2. GrowthBook `tengu_passport_quail` 未开 → return（`:533`）
3. `!isAutoMemoryEnabled()` → return（`src/memdir/paths.ts:30`：受 `CLAUDE_CODE_DISABLE_AUTO_MEMORY`、`--bare`、无持久存储、settings `autoMemoryEnabled` 影响）
4. `getIsRemoteMode()` → return（`:547`）
5. `inProgress` 为真 → 把 context 存进 `pendingContext`（覆盖旧值，只保留最新的），记 `tengu_extract_memories_coalesced`，return（`:554-561`）

## 四、runExtraction 主体

`extractMemories.ts:326-520`：

1. **与主 agent 互斥**：`hasMemoryWritesSince(messages, lastMemoryMessageUuid)`（`:120-147`）发现主线程本轮已经写过 memory 文件 → 跳过 fork，只推进游标，记 `tengu_extract_memories_skipped_direct_write`（`:345-357`）
2. **节流**：非 trailing run 时 `turnsSinceLastExtraction++`，小于 `tengu_bramble_lintel`（默认 1）就 return（`:374-382`）。trailing run 跳过节流，因为它处理的是已提交的工作
3. **预注入 manifest**：`formatMemoryManifest(await scanMemoryFiles(memoryDir, signal))`（`:395-397`），省掉 agent 一次 `ls`。放在节流之后，避免被跳过的轮次白付扫描成本
4. **构造 prompt**：`buildExtractCombinedPrompt`（TEAMMEM 且团队记忆开启）或 `buildExtractAutoOnlyPrompt`（`src/services/extractMemories/prompts.ts:50`、`101`），参数：`newMessageCount`、`existingMemories`、`skipIndex`（`tengu_moth_copse`）
5. **fork 执行**（`:412-424`）：
   ```ts
   runForkedAgent({
     promptMessages: [createUserMessage({ content: userPrompt })],
     cacheSafeParams,           // createCacheSafeParams(context)，与父共享 cache key
     canUseTool,                // createAutoMemCanUseTool(memoryDir)
     querySource: 'extract_memories',
     forkLabel: 'extract_memories',
     skipTranscript: true,      // 不落 sidechain transcript，避免与主线程竞态
     maxTurns: 5,               // 硬上限，防止验证兔子洞
   })
   ```
6. **成功后才推进游标**（`:426-432`）；失败被 catch（`:494`）后游标不动，这些消息下次仍会被重新考虑
7. **结果处理**：`extractWrittenPaths` → 过滤掉索引文件 `MEMORY.md`（`ENTRYPOINT_NAME`）→ `createMemorySavedMessage(memoryPaths)` → `appendSystemMessage?.(msg)`（`:487-493`，UI 上显示「memory saved」）
8. **遥测**：`tengu_extract_memories_extraction`（`:470-482`，含 token/turn/文件数/耗时/缓存命中）

## 五、并发模型（in-flight + trailing run）

- `inFlightExtractions: Set<Promise<void>>`（`:300`）记录所有未 settle 的 promise
- `extractor` 包装器（`:566-574`）把每次调用加入集合并在 finally 移除
- `finally` 中若有 `pendingContext` 则**递归**跑一次 `runExtraction({ isTrailingRun: true })`（`:500-519`）；因为递归发生在游标推进之后，trailing run 只处理两次调用之间新增的消息，不重复全量
- `drainer(timeoutMs = 60_000)`（`:576-583`）`Promise.race([Promise.all(inFlight), 60s 超时])`

## 六、排空（非交互 -p / SDK）

`src/cli/print.ts:984-992`：刷完响应、`gracefulShutdownSync` 之前 `await drainPendingExtraction()`，否则 5s 关停保险丝会杀掉还在跑的 fork。

## 七、权限边界

`createAutoMemCanUseTool(memoryDir)`（`extractMemories.ts:170-221`）：

- `REPL` → allow（REPL 模式下原始工具被隐藏，内部每个原语仍会再走一遍这里的检查；给 fork 不同的工具列表会破坏 prompt cache，因为 tools 属于 cache key）
- `Read` / `Grep` / `Glob` → allow（只读）
- `Bash` → 仅当 `tool.isReadOnly(parsed)` 通过
- `Edit` / `Write` → 仅当 `isAutoMemPath(file_path)`（`src/memdir/paths.ts:258`，路径规范化后前缀匹配 memory 目录）
- 其余 → deny + `tengu_auto_mem_tool_denied`

## 八、`extract_memories` 作为 querySource 的特殊待遇

与 `session_memory` 基本一致：

| 位置 | 行为 |
|------|------|
| `src/query.ts:851-852` | **未**列入跳过列表（跳过列表只有 `compact` 和 `session_memory`）→ 仍受 blocking limit 检查 |
| `src/query.ts:585-587` | 不匹配前缀 → 不做 tool result 替换持久化 |
| `src/services/api/claude.ts:1107-1116` | `isAgenticQuery=false`（注释里明确点名 `extract_memories` 属于非 agentic） |
| `src/services/api/withRetry.ts:62-89` | 不在 `FOREGROUND_529_RETRY_SOURCES` → 529 立即失败 |
| `src/services/api/promptCacheBreakDetection.ts:143-147` | untracked source，不做 cache break 检测 |
| `src/services/compact/microCompact.ts:276-280` | 不参与 cached microcompact |

## 九、与 session_memory 的差异速览

| 维度 | session_memory | extract_memories |
|------|----------------|-----------------|
| 触发点 | post-sampling hook（每轮采样后，`src/query.ts:1318`） | stop hooks（一轮 query loop 结束，`src/query/stopHooks.ts:152`） |
| 注册 | `src/setup.ts:298`（同步，随 auto-compact 开关） | `src/utils/backgroundHousekeeping.ts:32`（动态 import） |
| 产物 | 单个会话笔记 markdown（供压缩续接） | `~/.claude/projects/<path>/memory/` 下多个主题文件 + `MEMORY.md` 索引 |
| fork 工具权限 | 仅 Edit 那一个笔记文件 | Read/Grep/Glob + 只读 Bash + memory 目录内 Edit/Write |
| maxTurns | 未限制 | 5 |
| transcript | 记录 sidechain | `skipTranscript: true` |
| 并发控制 | `sequential()` 串行 | `inProgress` + `pendingContext` trailing run |
| 节流 | token 阈值（必要）+ 工具调用数 / 末轮无工具调用 | `tengu_bramble_lintel` 每 N 轮 |
| 主线程写过则跳过 | 无 | 有（`hasMemoryWritesSince`） |
| 手动入口 | `manuallyExtractSessionMemory()`（/summary） | 无（靠 `drainPendingExtraction` 排空） |
