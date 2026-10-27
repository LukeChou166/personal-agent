# src/utils/model/model.ts —— 二级（小/快）模型取值链

面向问题：WebFetch 的二级总结（`queryHaiku`）到底用的是哪个模型，能不能从 `~/.claude/settings.json` 配。

## 1. 谁在用

`queryHaiku`（`src/services/api/claude.ts:3485`）在 `src/services/api/claude.ts:3523` 用 `model: getSmallFastModel()` 指定模型。调用方包括：

- `packages/builtin-tools/src/tools/WebFetchTool/utils.ts:565` —— WebFetch 抓取后的"小模型总结"
- `src/utils/hooks/execPromptHook.ts:79`、`execAgentHook.ts:141`、`skillImprovement.ts:229`
- `src/services/awaySummary.ts:48`、`src/utils/agenticSessionSearch.ts:261`
- `src/utils/permissions/permissionExplainer.ts:178`（穷鬼模式）、`src/cli/handlers/autoMode.ts:96`

## 2. 取值链（`src/utils/model/model.ts:67-108`）

`modelType: "openai"`（来自 `~/.claude/settings.json` → `getAPIProvider()`，`src/utils/model/providers.ts:12-29`）时：

1. ChatGPT OAuth 模式：`resolveChatGPTCodexModelForTier({ tier:'haiku', taskOverride: OPENAI_SMALL_FAST_MODEL, tierOverride: OPENAI_DEFAULT_HAIKU_MODEL })`
2. `OPENAI_SMALL_FAST_MODEL` —— 显式的"小模型"覆盖
3. `OPENAI_DEFAULT_HAIKU_MODEL` —— haiku 档模型（**当前配置：qwen3.5-plus**）
4. 兜底：`ANTHROPIC_SMALL_FAST_MODEL` → `getDefaultHaikuModel()`（3P provider 会回落到 provider 主模型 `OPENAI_MODEL`，不再硬编码 `claude-haiku-4-5-*`）

其余 provider：gemini 走 `GEMINI_SMALL_FAST_MODEL`，其它走 `ANTHROPIC_SMALL_FAST_MODEL || getDefaultHaikuModel()`。

## 3. 配置怎么进来的

`~/.claude/settings.json`：`modelType` 决定 provider，`env` 里的变量由
`applySafeConfigEnvironmentVariables()`（`src/utils/managedEnv.ts:124-178`）注入 `process.env`，
只放行 `SAFE_ENV_VARS` 白名单（`src/utils/managedEnvConstants.ts:148+`，含
`OPENAI_SMALL_FAST_MODEL`、`OPENAI_DEFAULT_HAIKU_MODEL`、`OPENAI_MODEL`）。
注入发生在启动早期：`src/entrypoints/init.ts`（CLI）/ `src/services/acp/entry.ts:28-34`（ACP）。

所以 **模型名不需要硬编码**：settings.json 的 `env.OPENAI_DEFAULT_HAIKU_MODEL` 就是二级模型的来源。

## 4. 本次改动

抽出了纯函数 `resolveOpenAISmallFastModel(env)`（`model.ts:87-91`），让 openai 分支显式取
settings.json 配置、语义清晰且可单测（直接 import `model.ts` 会拉起 auth/settings 等重依赖链，
在 `bun test` 里容易被进程级 mock 污染，同 `providers.test.ts` 的做法）。

单测：`src/utils/model/__tests__/getSmallFastModel.test.ts`

```bash
bun test src/utils/model/__tests__/getSmallFastModel.test.ts
```

## 5. 实测验证（当前环境）

```text
provider                 = openai
OPENAI_MODEL             = qwen3.5-plus
OPENAI_DEFAULT_HAIKU_MODEL = qwen3.5-plus
getSmallFastModel()      = qwen3.5-plus
```

注意：直接 `bun run` 一个脚本 import `model.ts` **不会**注入 settings.json 的 env，此时
`getSmallFastModel()` 会返回默认的 `claude-haiku-4-5-20251001`。排查脚本里必须先
`enableConfigs()` + `applySafeConfigEnvironmentVariables()` 才能复现真实取值。

## 6. 相关坑

模型名对了 ≠ 结果对：qwen3.5-plus 会返回 thinking 块，WebFetch 曾因为只取 `content[0]`
而回填 "No response from model"。详见 `packages/builtin-tools/src/tools/WebFetchTool/utils.md` 第 5 节。
