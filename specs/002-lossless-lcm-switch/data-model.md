# Data Model: Lossless-Claw 无损上下文适配

**Feature**: `002-lossless-lcm-switch` | **Date**: 2026-11-21 | **Source**: [spec.md](./spec.md) 的 Key Entities

所有持久化实体都按会话隔离，磁盘位置见 [contracts/storage-format.md](./contracts/storage-format.md)。字段命名与设置项保持一致，便于 `/lossless status` 直接映射。

---

## 1. LosslessSetting（生效中的开关配置）

由用户级 → 项目级（含项目本地）→ 环境变量 → 会话命令逐层覆盖后的快照，只在内存中存在。

| 字段 | 类型 | 说明 | 约束 |
|---|---|---|---|
| `enabled` | boolean | 是否启用无损模式 | 默认 `false` |
| `source` | `'user' \| 'project' \| 'local' \| 'env' \| 'session' \| 'default'` | 最终生效来源 | 必须可被 `/lossless status` 读出（FR-001） |
| `storeRoot` | string | 存储根目录 | 必须在用户配置目录下，不得位于仓库工作区（FR-017） |
| `freshTailCount` | number | 受保护不摘要的近期消息数 | 1–1000，默认 64 |
| `contextThreshold` | number | 触发摘要的上下文占比 | 0.1–0.99，默认 0.75 |
| `leafChunkTokens` | number | 单个叶子分块的最大源 token | ≥1000，默认 20000 |
| `leafMinFanout` | number | 叶子摘要最少覆盖消息数 | ≥2，默认 8 |
| `leafTargetTokens` | number | 叶子摘要目标 token | ≥200，默认 2400 |
| `condensedMinFanout` | number | 浓缩摘要最少子节点数 | ≥2，默认 4 |
| `condensedTargetTokens` | number | 浓缩摘要目标 token | ≥200，默认 2000 |
| `incrementalMaxDepth` | number | 每轮允许新增的浓缩层数；`0` 仅叶子，`-1` 不限 | 默认 1 |
| `largeFileTokenThreshold` | number | 超过则隔离存储并摘要 | ≥1000，默认 25000 |
| `maxExpandTokens` | number | 单次展开上限 | ≤8000，默认 4000 |
| `summaryModel` | string? | 摘要模型覆盖 | 缺省用当前主模型 |
| `summaryTimeoutMs` | number | 单次摘要超时 | >0，默认 60000 |
| `summaryCallWindowMs` | number | 花费统计窗口 | >0，默认 600000 |
| `summaryMaxCallsPerWindow` | number | 窗口内最大摘要调用次数 | ≥0（0 = 不限制），默认 24 |
| `summarySpendBackoffMs` | number | 触发后的冷却时长 | ≥0，默认 1800000 |
| `ignoreSessionPatterns` | string[] | 完全不记录的会话匹配 | 逗号分隔 glob；`*` 不跨 `:`，`**` 跨 `:` |
| `statelessSessionPatterns` | string[] | 只读不写的会话匹配 | 同上 |
| `schemaVersion` | number | 磁盘格式版本 | 当前 `1` |

**校验规则**: 数值范围越界时按最近边界收敛并在 `/lossless status` 给出一次提示，不阻止启用；未知字段忽略。设置解析复用 `getSettingsWithSources()`（`src/utils/settings/settings.ts:836`）以读取逐源内容，用于计算 `source`。

---

## 2. SessionArchive（会话档案）

一个会话对应一个目录，档案元数据存于 `meta.json`。

| 字段 | 类型 | 说明 |
|---|---|---|
| `sessionId` | string | 会话标识，来自 `getSessionId()`（`src/bootstrap/state.ts`） |
| `projectKey` | string | 项目目录名（与现有 `projects/<hash>` 同源） |
| `createdAt` / `updatedAt` | ISO string | 首次/最近写入时间 |
| `lastSeq` | number | 已落盘的最大序号（幂等去重依据） |
| `lastUuid` | string? | 最后一条消息的 uuid |
| `messageCount` | number | 已落盘消息数 |
| `nodeCount` | number | 摘要节点总数 |
| `bytes` | number | 近似占用（消息 + 节点文件） |
| `schemaVersion` | number | 与写入端一致，不匹配时进入只读模式并提示 |

**不变量**: `lastSeq` 严格单调递增；同一 `uuid` 在 `messages.jsonl` 中最多出现一次；`messageCount` 可由文件行数重算，仅作为快速读数。

---

## 3. MessageRecord（`messages.jsonl` 每行一条）

| 字段 | 类型 | 说明 | 约束 |
|---|---|---|---|
| `v` | number | 记录版本 | 当前 `1` |
| `seq` | number | 会话内递增序号 | ≥1，唯一 |
| `uuid` | string | 消息标识 | 唯一，与内存消息一致 |
| `ts` | ISO string | 写入时间 | — |
| `role` | `'user' \| 'assistant' \| 'system' \| 'attachment' \| 'progress'` | 来源类型 | 映射 `Message.type` |
| `blocks` | `Record<string, unknown>[]` | 归一化后的内容块（文本 / 工具调用 / 工具结果） | 至少一个块 |
| `toolUseId` | string? | 工具调用/结果关联 | 与 `blocks` 中的 id 一致 |
| `toolName` | string? | 工具名 | 便于按工具过滤 |
| `tokenEstimate` | number | 记录级 token 估算 | >0 |
| `large` | boolean | 是否超过大块阈值 | 与 `largeFileTokenThreshold` 对应 |
| `summaryOf` | string? | 该记录是否为「大块内容摘要替身」 | 为真时 `blocks` 只含摘要 |
| `sourceRef` | string? | 大块原文的落盘引用（复用现有 persisted-output） | 与 `large` 联动 |

**校验规则**: 解析失败的行跳过并累加 `corruptLines`（FR-011 的可观测依据）；`seq` 不连续时按「文件顺序」为准，不阻断。

---

## 4. SummaryNode（`nodes.jsonl` 每行一条）

| 字段 | 类型 | 说明 | 约束 |
|---|---|---|---|
| `v` | number | 记录版本 | `1` |
| `id` | string | 节点 id（稳定，用于 describe/expand） | 唯一 |
| `sessionId` | string | 所属会话 | 必须与目录一致 |
| `depth` | number | 层级；叶子为 1 | ≥1 |
| `kind` | `'leaf' \| 'condensed'` | 节点类型 | — |
| `childNodeIds` | string[] | 浓缩节点引用的下层节点 | `condensed` 时非空；`leaf` 时为空 |
| `span` | `{firstSeq:number,lastSeq:number}` | 覆盖的原始消息序号区间 | `firstSeq ≤ lastSeq` |
| `messageIds` | string[] | 叶子节点覆盖的消息 uuid（可选，过大时省略） | `leaf` 且未超限时存在 |
| `text` | string | 摘要正文 | 非空 |
| `tokenEstimate` | number | 摘要规模 | >0 |
| `model` | string | 生成摘要所用模型 | 便于成本归因 |
| `createdAt` | ISO string | 生成时间 | — |
| `status` | `'active' \| 'corrupt'` | 健康状态 | 校验失败记为 `corrupt`，只读诊断可见 |

**校验规则**: `condensed` 节点至少 2 个子节点且子节点 `depth = depth - 1`；`span` 必须落在已落盘消息范围内；子节点缺失时整节点记 `corrupt`，但不删除（只读诊断报告）。

---

## 5. CompactionBacklog（待压缩状态）

持久化在 `meta.json` 的 `backlog` 字段。

| 字段 | 类型 | 说明 |
|---|---|---|
| `pendingMessages` | number | 尚未被任何叶子覆盖的消息数 |
| `pendingNodes` | number | 满足扇出但尚未浓缩的节点数 |
| `failures` | number | 连续摘要失败次数；成功后清零 |
| `nextRetryAt` | ISO string? | 允许下次自动重试的时间（护栏触发时写入） |
| `lastError` | string? | 最近一次失败的可读原因（截断到 200 字符） |
| `tripped` | boolean | 连续失败达到阈值后的熔断标记 |

**状态迁移**: `idle → running → drained`；失败时 `running → deferred`（写 `nextRetryAt`），`failures ≥ 3` 时 `deferred → tripped`（本会话不再自动重试，`/lossless status` 可见）。

---

## 6. GuardState（花费护栏）

持久化在 `meta.json` 的 `guard` 字段。

| 字段 | 类型 | 说明 |
|---|---|---|
| `windowStart` | ISO string | 当前统计窗口起点 |
| `callsInWindow` | number | 窗口内已发起的摘要调用数 |
| `backoffUntil` | ISO string? | 冷却截止时间 |
| `lastCallAt` | ISO string? | 最近一次调用时间 |

**状态迁移**: `closed → throttled`（达到 `summaryMaxCallsPerWindow`）`→ open`（冷却期内拒绝调用）`→ closed`（窗口滚动或冷却结束）。

---

## 7. RetrievalHit（检索命中，内存结构，不落盘）

| 字段 | 类型 | 说明 |
|---|---|---|
| `sessionId` | string | 归属会话（隔离校验，FR-006） |
| `messageId` / `seq` | string / number | 定位 |
| `ts` | ISO string | 时间 |
| `role` | string | 角色 |
| `snippet` | string | 命中片段（前后各约 120 字符） |
| `score` | number | 命中次数（简单计数，不做 TF-IDF） |
| `nodeId` | string? | 若命中摘要节点，给出节点 id 与深度 |

---

## 8. 关系与隔离

```text
SessionArchive 1 ── n MessageRecord
SessionArchive 1 ── n SummaryNode
SummaryNode(leaf)        ──span──▶ MessageRecord[]           (1..n)
SummaryNode(condensed)   ──childNodeIds──▶ SummaryNode[]     (2..n, depth-1)
SummaryNode(any)         ──span──▶ 该区间内的 MessageRecord
```

- 所有读取入口先按 `sessionId` 目录定位，禁止跨会话 join（FR-006）。
- 项目级设置只决定「是否启用」，不改变存储根路径；存储始终在用户目录（FR-017）。
- 关闭开关不删除任何记录（FR-010）；v1 不提供清理能力。
