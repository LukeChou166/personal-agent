# Contract: 设置项与优先级

**Feature**: `002-lossless-lcm-switch` | **Version**: 1

## 1. `settings.json` 中的字段

新增顶层键 `lossless`（与 `poorMode` 同为可选键，位置见 `src/utils/settings/types.ts` 的 `SettingsSchema`）：

```json
{
  "lossless": {
    "enabled": true,
    "freshTailCount": 64,
    "contextThreshold": 0.75,
    "leafChunkTokens": 20000,
    "leafMinFanout": 8,
    "leafTargetTokens": 2400,
    "condensedMinFanout": 4,
    "condensedTargetTokens": 2000,
    "incrementalMaxDepth": 1,
    "largeFileTokenThreshold": 25000,
    "maxExpandTokens": 4000,
    "summaryModel": "claude-sonnet-4-5",
    "summaryTimeoutMs": 60000,
    "summaryCallWindowMs": 600000,
    "summaryMaxCallsPerWindow": 24,
    "summarySpendBackoffMs": 1800000,
    "ignoreSessionPatterns": ["agent:*:cron:**"],
    "statelessSessionPatterns": ["agent:*:subagent:**"]
  }
}
```

所有字段可选。字段语义与默认值见 [data-model.md](../data-model.md) 的 `LosslessSetting`。

**兼容规则**:
- 未知字段 MUST 被忽略，不报错。
- 类型错误 MUST 由现有 zod 校验捕获并走既有设置告警通道，不阻断启动。
- 越界数值 MUST 收敛到最近合法边界，并在 `/lossless status` 中标记 `clamped: true`。

## 2. 生效优先级（FR-001）

从低到高：

1. 用户级设置（`~/.claude/settings.json`）
2. 项目级设置（`.claude/settings.json`）
3. 项目本地设置（`.claude/settings.local.json`）
4. 环境变量（见下）
5. 会话内命令（`/lossless on|off`，仅当前进程有效）

最终生效来源必须可被 `/lossless status` 输出为 `source: user | project | local | env | session | default`。

实现说明：合并值复用 `getInitialSettings()`；来源判定复用 `getSettingsWithSources()`（`src/utils/settings/settings.ts:836`），在只包含 `lossless` 键的逐源视图上从高到低查找。

## 3. 环境变量

| 变量 | 取值 | 作用 |
|---|---|---|
| `CLAUDE_CODE_LOSSLESS` | `1` / `0` / `true` / `false` | 覆盖 `enabled`，优先级高于所有设置文件 |
| `LOSSLESS_DATABASE_PATH` | 绝对路径 | 覆盖 `storeRoot`（便于测试与迁移） |
| `LOSSLESS_SUMMARY_MODEL` | 模型 id | 覆盖 `summaryModel` |
| `LOSSLESS_MAX_EXPAND_TOKENS` | 正整数 | 覆盖 `maxExpandTokens` |

解析规则与仓库现有 `isEnvTruthy` 一致（`src/utils/envUtils.ts`）。

## 4. 关闭时的保证（FR-002 / SC-001）

- 不创建 `storeRoot` 目录与任何文件。
- 不注册 post-sampling 钩子（或注册但首行即返回，且不产生 I/O）。
- 不把 `LcmGrep` / `LcmDescribe` / `LcmExpand` 放入工具列表。
- 不发起任何 `querySource: 'lossless_summary'` 的请求。

以上四条须由自动化测试逐条断言。
