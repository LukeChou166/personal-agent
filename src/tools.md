# src/tools.ts —— 工具的开关在哪控制（含 TodoWrite 为什么没开启）

> 问题：tool 的开关在哪控制？`TodoWriteTool` 在日志里看着没开启。

## 0. 总览：一条工具从「注册」到「发给模型」要过 6 层

```text
① 编译期 feature('XXX')         bun:bundle，build.ts:12-16 收集 FEATURE_* 环境变量 + DEFAULT_BUILD_FEATURES
    ↓ 决定「这个模块有没有被 require 进来」
② 进程环境变量（top-level）      src/tools.ts:16-60 / 106-160（USER_TYPE、CLAUDE_CODE_VERIFY_PLAN、ENABLE_LSP_TOOL...）
    ↓
③ getAllBaseTools() 是否入列表   src/tools.ts:218-284（含 isTodoV2Enabled() 这种运行时判定）
    ↓
④ per-tool isEnabled()           src/tools.ts:358-359（最后一刀，决定它是否真的暴露给模型）
    ↓
⑤ deny 规则过滤                  src/tools.ts:343 → filterToolsByDenyRules:295-302
    （--tools / --disallowedTools / settings.permissions.deny）
    ↓
⑥ 场景子集过滤                    agent 子集（src/constants/tools.ts:44/71/124）
                                 REPL 模式（src/tools.ts:347-356）
                                 coordinator 模式（src/utils/toolPool.ts:55-79）
                                 tool search 延迟加载（SearchExtraToolsTool/prompt.ts:69-78）
```

最终交给模型的是 `assembleToolPool()`：`src/tools.ts:378-400`，被 `src/hooks/useMergedTools.ts:29`（REPL）和 `runAgent.ts`（子代理）共用。

## 1. 各层明细 + 引用位置

### ① 编译期 feature flag

- 声明：`import { feature } from 'bun:bundle'`（`src/tools.ts:119`），类型在 `src/types/internal-modules.d.ts`。
- 生效方式：`build.ts:12-16` 把 `DEFAULT_BUILD_FEATURES`（`scripts/defines.ts:39-102`，约 40 个）与环境变量 `FEATURE_<NAME>=1` 合并后传给 `Bun.build({ features })`；dev 模式由 `scripts/dev.ts` 全部注入。
- 影响的工具（不在列表里就连 require 都不发生，被 dead-code elimination 掉）：
  - `SleepTool` `src/tools.ts:27-30`（`PROACTIVE || KAIROS`）
  - `RemoteTriggerTool` `:39-42`、`MonitorTool` `:43-46`、`SendUserFileTool` `:47-50`、`PushNotificationTool` `:51-55`、`SubscribePRTool` `:56-59`
  - `GoalTool` `:91-94`、`OverflowTestTool` `:122-125`、`CtxInspectTool` `:126-129`、`TerminalCaptureTool` `:130-133`、`WebBrowserTool` `:134-137`、`SnipTool` `:141-144`、`DiscoverSkillsTool` `:145-148`、`ReviewArtifactTool` `:149-152`、`ListPeersTool` `:153-156`、`WorkflowTool` `:157-159`
- **改这一层必须 `bun build` / `bun run` 验证**，`bun run typecheck` 查不出来（`feature()` 在类型上就是个普通 `boolean` 函数）。

### ② 进程环境变量（top-level 判定）

- `process.env.USER_TYPE === 'ant'` → `REPLTool` `:16-20`、`ConfigTool` `:242`、`TungstenTool` `:244`、`SuggestBackgroundPRTool` `:21-25`
- `process.env.CLAUDE_CODE_VERIFY_PLAN === 'true'` → `VerifyPlanExecutionTool` `:106-110`
- `isEnvTruthy(process.env.ENABLE_LSP_TOOL)` → `LSPTool` `:253`
- `isWorktreeModeEnabled()` → `EnterWorktreeTool/ExitWorktreeTool` `:254`
- `process.env.NODE_ENV === 'test'` → `TestingPermissionTool` `:274`
- `hasEmbeddedSearchTools()` → 有内建 bfs/ugrep 时干脆不下发 `Glob/Grep` `:226`
- `isPowerShellToolEnabled()` → `PowerShellTool` `:175-180`
- `isSearchExtraToolsEnabledOptimistic()` → `SearchExtraToolsTool` `:279`

### ③ 列表准入

`getAllBaseTools()` `src/tools.ts:218-284` 是「所有可能出现的内置工具」的唯一来源；`getToolsForDefaultPreset()` `:204-208` 用它 + `isEnabled()` 算出 `--tools` 的补集。

### ④ isEnabled()（真正意义上「开没开」）

```text
src/tools.ts:358-359
  const isEnabled = allowedTools.map(_ => _.isEnabled())
  return allowedTools.filter((_, i) => isEnabled[i])
```

这是**最后一刀**，也是判断「日志里为什么没它」时最该看的一层。

### ⑤ deny 规则（`--tools` / `--disallowedTools` / settings）

- CLI 选项注册：`src/main.tsx:1302-1312`（`--allowedTools`、`--tools`、`--disallowedTools`）
- 解参：`src/main.tsx:1546-1548`，传入 `initializeToolPermissionContext`（`src/main.tsx:2238-2241`）
- `--tools` 的实现是「**取补集 → 全部 deny**」：`src/utils/permissions/permissionSetup.ts:900-910`（先用 `getToolsForDefaultPreset()` 拿到全量工具名，不在 `--tools` 集合里的全部塞进 `parsedDisallowedToolsCli`）
- 过滤发生在 `filterToolsByDenyRules`：`src/tools.ts:295-302`，用的是与运行时权限同一套 matcher，所以 `mcp__server` 这类前缀规则会在模型看到工具之前就把整组 MCP 工具摘掉

### ⑥ 场景子集

- 子代理禁/许用表：`src/constants/tools.ts:44-62`（`ALL_AGENT_DISALLOWED_TOOLS`）、`:71-88`（`ASYNC_AGENT_ALLOWED_TOOLS`）、`:94-105`（in-process teammate）
- coordinator 模式白名单：`src/constants/tools.ts:124-129`，过滤在 `src/utils/toolPool.ts:35-41 / 72-76`
- `CLAUDE_CODE_SIMPLE=1`：只留 `Bash/Read/Edit`（`src/tools.ts:306-331`）
- REPL 模式：把 `REPL_ONLY_TOOLS` 里的原始工具藏起来（`src/tools.ts:347-356`）
- Tool Search 延迟加载：`isDeferredTool()`（`packages/builtin-tools/src/tools/SearchExtraToolsTool/prompt.ts:69-78`）——`CORE_TOOLS`（`src/constants/tools.ts:137-179`）之外的工具都以 `defer_loading` 方式下发，要靠 `SearchExtraToolsTool` 发现；模式由 `ENABLE_SEARCH_EXTRA_TOOLS` 控制（`src/utils/searchExtraTools.ts:159-190`）

## 2. TodoWrite 为什么没开启

开关链只有 3 跳：

```text
src/tools.ts:234           TodoWriteTool 无条件进 getAllBaseTools()
   ↓
src/tools.ts:358-359       getTools() 末尾按 isEnabled() 过滤
   ↓
packages/builtin-tools/src/tools/TodoWriteTool/TodoWriteTool.ts:52-54
   isEnabled() { return !isTodoV2Enabled() }        ← 关键
   ↓
src/utils/tasks.ts:133-139
   isTodoV2Enabled():
     if (isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_TASKS)) return true
     return !getIsNonInteractiveSession()
   ↓
src/bootstrap/state.ts:1039-1041  getIsNonInteractiveSession() === !STATE.isInteractive
src/main.tsx:984-985             setIsInteractive(!isNonInteractive)
```

结论（与直觉相反）：

| 场景 | `isInteractive` | `isTodoV2Enabled()` | `TodoWrite` | `TaskCreate/Get/Update/List` |
|---|---|---|---|---|
| 交互 REPL（TTY，不带 `-p`/`--print`） | true | **true** | **关闭** | 开启（`src/tools.ts:247-249`） |
| 非交互（`-p` / `--print` / SDK） | false | false | **开启** | 不进列表 |
| 任意场景 + `CLAUDE_CODE_ENABLE_TASKS=1` | — | **true**（强制） | 关闭 | 开启 |

也就是说：**在交互式 REPL 里 `TodoWrite` 默认是被 `isEnabled()` 摘掉的**，任务管理走 Task V2（`TaskCreate/TaskGet/TaskUpdate/TaskList` + `src/hooks/useTasksV2.ts` / `src/components/TaskListV2.tsx`）。这是设计如此，不是配置丢失。参见单测 `src/utils/__tests__/tasks.test.ts:604-618`（"returns true in interactive sessions by default"）。

补充两点：

- 目前**没有**「关闭 Task V2、强制启用 TodoWrite」的环境变量——`CLAUDE_CODE_ENABLE_TASKS` 只能正向强制开启 Task V2；反过来要开 `TodoWrite`，只能改 `src/utils/tasks.ts:133-139`（例如新增 `CLAUDE_CODE_DISABLE_TASKS` 判定），或把 `TodoWriteTool.ts:52-54` 的 `isEnabled()` 改成 `return true`（但这样两类任务工具会同时出现）。
- `TodoWriteTool` 虽然 `shouldDefer: true`（`TodoWriteTool.ts:51`），但它名列 `CORE_TOOLS`（`src/constants/tools.ts:156`），所以**不会**被 tool search 延迟加载；一旦 `isEnabled()` 为 true 就会完整出现在首发 schema 里。
- 子代理侧：`TodoWrite` 显式写进了 `ASYNC_AGENT_ALLOWED_TOOLS`（`src/constants/tools.ts:74`），但它能否出现仍取决于主线程 `getTools()` 是否放行它。

## 3. 排查/验证入口

- 想看最终下发了哪些工具：`src/services/api/claude.ts:1907-1919` 的 `learningLog('api.request_params', ...)` 只打了 `tools: params.tools?.length`（条数，没有名字）；要看名字需要临时在 `src/tools.ts:358` 附近加日志。
- 想确认当前是交互还是非交互：`src/main.tsx:989-995` 的 `learningLog('main.session_mode', { isInteractive, hasPrintFlag, ... })`。
- 想确认被 deny 掉：`src/utils/permissions/permissionSetup.ts:900-910` 之后打印 `parsedDisallowedToolsCli`，或看 `src/tools.ts:343` 过滤前后的长度差。
