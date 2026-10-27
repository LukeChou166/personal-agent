# src/utils/api.ts 说明（`prependUserContext` / project-instructions 开关）

> 问题：`src/utils/api.ts:447-449` 的 `process.env.NODE_ENV === 'test'` 在哪配置的？能否把 `<project-instructions>` 的注入做成开关？

## 1. `NODE_ENV === 'test'` 的来源

`NODE_ENV` **不是仓库里某个配置文件显式设置的**，而是分两条路径产生：

| 场景 | NODE_ENV 值 | 来源 |
|---|---|---|
| `bun test` | `test` | Bun 测试运行器自动注入（部分测试文件也手动 `process.env.NODE_ENV = 'test'`，如 `src/services/skillLearning/__tests__/runtimeObserver.test.ts:27`） |
| `bun run dev` | `production` | `scripts/dev.ts:22` 通过 `-d process.env.NODE_ENV:"production"` 静态注入 |
| `bun run build`（产物） | `production` | `build.ts:30` 的 `define: { 'process.env.NODE_ENV': JSON.stringify('production') }` |

所以：

- dev / 生产产物中 `NODE_ENV !== 'test'` → `prependUserContext` 正常注入上下文（含 project-instructions）；
- 单测中命中 `src/utils/api.ts:447-449` 的 early return → 直接返回原 `messages`，不注入任何上下文（避免污染断言）。

`bunfig.toml` 里只有 `[test] root/timeout`，没有 NODE_ENV 相关配置。

## 2. `prependUserContext` 流程（`src/utils/api.ts:443-491`）

```
prependUserContext(messages, context)
├─ NODE_ENV === 'test'                 → 原样返回 messages      (api.ts:447-449)
├─ context 为空                         → 原样返回 messages      (api.ts:451-453)
├─ feature('PROJECT_INSTRUCTIONS') 开  → 把 context.claudeMd 单独包成
│                                         <project-instructions> 用户消息（isMeta）
│                                         其余 key 走 <system-reminder>   (api.ts:461-478)
└─ feature('PROJECT_INSTRUCTIONS') 关  → claudeMd 与其余 key 一起进
                                         <system-reminder>（不丢内容）    (api.ts:455-459, 480)
```

调用方：`src/query.ts:929` → `prependUserContext(messagesForQuery, userContext)`；另有
`src/utils/attachments.ts`、`src/components/agents/generateAgent.ts` 引用。

拆出独立 `<project-instructions>` 的目的：CLAUDE.md 不与 `<system-reminder>` 里的
"may or may not be relevant" 免责声明混在一起，避免指令权重被稀释（见 commit `84f12f34`）。

## 3. 开关：`PROJECT_INSTRUCTIONS`

- 定义位置：`scripts/defines.ts` → `DEFAULT_BUILD_FEATURES`（与 `NODE_ENV` 的 define 同源，
  被 `build.ts:16` 和 `scripts/dev.ts:39-40` 共同消费）
- 用法：`feature('PROJECT_INSTRUCTIONS')`，仅在 `src/utils/api.ts` 的 `if` 条件里调用
  （Bun 限制 `feature()` 只能出现在 if / 三元条件中，tsc 检查不出来，必须用 `bun run build` 验证）
- 默认值：**开启**（在 `DEFAULT_BUILD_FEATURES` 列表中）
- 关闭方式：把 `scripts/defines.ts` 中该行注释掉（与 `// 'HISTORY_SNIP'` 等条目同样的"开关"写法），
  然后重新 `bun run dev` / `bun run build`
- 追加开启：`FEATURE_PROJECT_INSTRUCTIONS=1 bun run dev`（若该行已被注释掉；
  `build.ts:12-16` / `scripts/dev.ts:35-38` 会合并 `FEATURE_*` 环境变量）
- 关闭后不会丢 CLAUDE.md：会回落到通用 `<system-reminder>` 块中

## 4. 验证

- `bun run typecheck` → 0 错误
- `bun run build` → 通过，且产物 `dist/chunk-*.js` 中仍含 `project-instructions`（证明 flag 为 ON）
