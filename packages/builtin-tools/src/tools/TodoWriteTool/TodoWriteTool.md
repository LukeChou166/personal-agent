# TodoWriteTool —— 启用开关与数据流

> 问题：TodoWriteTool 在日志里看着没开启。

## 开关（唯一入口）

```text
packages/builtin-tools/src/tools/TodoWriteTool/TodoWriteTool.ts:51-54
  shouldDefer: true,
  isEnabled() { return !isTodoV2Enabled() }
```

- 注册：无条件进 `getAllBaseTools()`（`src/tools.ts:234`）
- 过滤：`getTools()` 末尾 `isEnabled()`（`src/tools.ts:358-359`）
- 判定源：`src/utils/tasks.ts:133-139`（`isTodoV2Enabled()`）

含义：**交互 REPL 下 `isTodoV2Enabled()===true` → 本工具被摘掉**，任务改用 `TaskCreate/TaskGet/TaskUpdate/TaskList`；非交互（`-p`/SDK）下本工具生效。

## 相关常量

- 工具名 `TODO_WRITE_TOOL_NAME = 'TodoWrite'`（`packages/builtin-tools/src/tools/TodoWriteTool/constants.ts:1`）
- 在核心工具表里，不会被 tool search 延迟加载：`src/constants/tools.ts:156`（`CORE_TOOLS`），判定逻辑 `packages/builtin-tools/src/tools/SearchExtraToolsTool/prompt.ts:69-78`
- 子代理允许列表：`src/constants/tools.ts:74`（`ASYNC_AGENT_ALLOWED_TOOLS`）——但前提仍是主线程 `getTools()` 放行了它

## 调用行为

- `checkPermissions()`（`TodoWriteTool.ts:58-61`）：恒 `allow`，无权限校验
- `call()`（`TodoWriteTool.ts:65` 起）：以 `context.agentId ?? getSessionId()` 为 key 读写 `appState.todos`；全部完成时清空列表；`feature('VERIFICATION_AGENT')` + GB `tengu_hive_evidence` 命中时在收尾处追加 verification 提醒（`:77-80`）
