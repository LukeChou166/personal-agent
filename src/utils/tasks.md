# src/utils/tasks.ts —— isTodoV2Enabled()：TodoWrite vs Task V2 的总开关

> 问题：TodoWriteTool 在日志里看着没开启，开关在哪？

## 关键实现

```text
src/utils/tasks.ts:133-139
  export function isTodoV2Enabled(): boolean {
    if (isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_TASKS)) return true
    return !getIsNonInteractiveSession()
  }
```

依赖：

- `getIsNonInteractiveSession()` → `src/bootstrap/state.ts:1039-1041`，等于 `!STATE.isInteractive`
- `setIsInteractive()` → `src/main.tsx:984-985`（`isInteractive = !isNonInteractive`，`isNonInteractive` 来自 `-p/--print` 等）

## 消费方

| 位置 | 作用 |
|---|---|
| `packages/builtin-tools/src/tools/TodoWriteTool/TodoWriteTool.ts:52-54` | `isEnabled() { return !isTodoV2Enabled() }` —— 为 true 时 **TodoWrite 被摘掉** |
| `src/tools.ts:247-249` | `isTodoV2Enabled() ? [TaskCreate, TaskGet, TaskUpdate, TaskList] : []` |
| `src/utils/__tests__/tasks.test.ts:604-618` | 单测：交互会话默认返回 true（即默认走 Task V2） |

## 真值表

| 场景 | `CLAUDE_CODE_ENABLE_TASKS` | `isInteractive` | `isTodoV2Enabled()` | TodoWrite | Task* 四件套 |
|---|---|---|---|---|---|
| 交互 REPL | 未设 | true | true | 关闭 | 开启 |
| `-p` / SDK | 未设 | false | false | 开启 | 关闭 |
| 任意 | `1` | 任意 | true | 关闭 | 开启 |

注意：**没有反向开关**。设 `CLAUDE_CODE_ENABLE_TASKS=0` 只会落到默认分支（交互下仍为 true），无法用环境变量在交互模式里重新打开 TodoWrite；需要改本函数或 `TodoWriteTool.isEnabled()`。
