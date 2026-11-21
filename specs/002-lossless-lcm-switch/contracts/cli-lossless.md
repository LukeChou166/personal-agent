# Contract: `/lossless` 命令

**Feature**: `002-lossless-lcm-switch` | **Version**: 1

命令声明沿用 `src/commands/poor/index.ts` 的模式：`{ type: 'local', name: 'lossless', supportsNonInteractive: true, load: () => import('./lossless.js') }`。

## 子命令

| 调用 | 行为 | 持久化 |
|---|---|---|
| `/lossless` | 等价于 `/lossless status` | 否 |
| `/lossless status` | 输出当前状态（只读，不写盘） | 否 |
| `/lossless on` | 当前进程内开启（`source: session`） | 否 |
| `/lossless off` | 当前进程内关闭（`source: session`） | 否 |
| `/lossless on --save` | 开启并写入用户级设置 | 是 |
| `/lossless off --save` | 关闭并写入用户级设置 | 是 |
| `/lossless doctor` | 只读诊断：扫描节点与消息一致性 | 否 |
| `/lossless help` | 用法说明 | 否 |

**生效时机**: `on` / `off` 只影响下一轮对话开始后的行为（FR-010）；当前轮不中断。命令 MUST 输出一行确认，包含「下一轮生效」。

## `status` 输出契约（人类可读 + 稳定字段）

```text
lossless: ON (source: project)
  store: ~/.claude/lossless/<project>/<session>  (12.4 MB, 1,832 messages)
  summaries: 9 nodes (depth 1: 7, depth 2: 2)
  backlog: 34 messages pending, 0 failures, retry in 0s
  guard: 3/24 calls in window, backoff: none
  summary model: claude-sonnet-4-5 (default: main loop model)
```

字段要求（对应 FR-007）：

- 开关状态与生效来源
- 存储路径与占用
- 节点数与分层分布
- 待压缩数量、连续失败次数、下次重试时间
- 护栏窗口用量与冷却状态
- 摘要模型与是否为覆盖值

`status` MUST 在 200ms 内返回（不对消息正文做全量扫描；用 `meta.json` 计数）。

## `doctor` 输出契约（只读）

```text
lossless doctor
  messages: 1,832 ok, 0 corrupt lines
  nodes: 9 ok, 1 corrupt (node 7f3a…: missing child 91c2…)
  spans: 0 gaps, 0 overlaps
  next: 受影响的摘要节点将在下次压缩时被重建；本命令不修改任何数据
```

**约束**:
- MUST 不修改任何数据（spec 的 US3 场景 3）。
- MUST 不发起模型调用。
- 损坏项只报告，不修复（修复能力在 Out of Scope）。

## 失败与边界

| 情况 | 行为 |
|---|---|
| 存储目录不可写 | `status` 显示 `store: unavailable (<reason>)`，退出码 0；对话按降级路径继续（FR-011） |
| 未开启 | `status` 显示 `lossless: OFF (source: default)` 并给出开启方式 |
| `doctor` 无数据 | 显示 `lossless: no records for this session`，退出码 0 |
| 非交互模式 | `supportsNonInteractive: true`，结果为纯文本（`LocalCommandResult` 的 `type: 'text'`），字段顺序稳定，便于脚本断言 |

## 退出码

`0` = 命令正常完成（包括「发现损坏」这种正常报告）；`1` = 参数非法；`2` = 内部异常。
