# Research: Lossless-Claw 无损上下文适配

**Feature**: `002-lossless-lcm-switch` | **Date**: 2026-11-21

本文件记录 Phase 0 的技术决策。所有决策都以「关闭时零副作用、单 PR ≤500 行、不新增二进制依赖」为前提。

---

## R1. 适配方式：内建同等能力，不实现插件宿主

**Decision**: 参考 lossless-claw 的能力与配置语义，在本仓库内实现上下文引擎；上游仓库仅作参考实现，固定版本并保留 MIT 归属。

**Rationale**:
- 上游是「宿主插件的进程内上下文引擎」，其对外契约分散在插件加载、槽位注册、会话钩子（`afterTurn` / `before_prompt_build` / `before_reset` / `session_end`）、宿主模型运行时、会话键与 transcript 读取、版本兼容检查上。
- 为安装一个插件而重建整套宿主协议，等于长期维护一个与上游同步的兼容层；上游仍在高频演进，兼容成本不可控。
- 本仓库已有成熟的压缩与消息管道，直接接入成本低于模拟另一个宿主。

**Alternatives considered**:
- 方案 A（实现插件格式 + 直接安装插件）：保真度最高，但需要实现并持续跟随上游宿主协议，弃用。
- 方案 C（只实现最小宿主适配层，加载上游包内引擎）：上游发布物是宿主插件，引擎未作为可独立实例化的库导出，且工具注册依赖宿主 API，实际会退化回方案 A。

**上游固定**: 参考版本以 README 所列 `latest` 为基线，实施时在 `src/services/lossless/README.md` 记录具体版本号或提交标识与 MIT 许可声明（对应 FR-015）。

---

## R2. 存储格式：追加式 JSONL，不用 SQLite

**Decision**: 每会话三个文件——`messages.jsonl`（消息原文）、`nodes.jsonl`（摘要节点）、`meta.json`（版本、计数、护栏状态、最后写入位置）。追加写，读取时逐行解析，损坏行跳过并计数。

**Rationale**:
- 运行时分两套：开发/构建用 Bun，产物要求可在 Node 运行。`bun:sqlite` 仅 Bun 可用，会在 Node 产物中直接失败；`better-sqlite3` 需原生编译，违反「不新增二进制依赖」。
- 需求里的检索规模是单会话 ≤10k 条、≤50MB。按 1MB 分块扫描 + 仅解析命中行，实测路径远低于 1s 目标（SC-004），不需要倒排索引即可达标。
- 追加写天然抗崩溃：最坏情况丢最后一行未写完的记录，前面的记录仍可解析；SQLite 需要额外处理 WAL 与损坏恢复。
- 与仓库现有会话 transcript（`src/utils/sessionStorage.ts:203` 的 `getTranscriptPath`）同为 JSONL 风格，维护者心智一致。

**Alternatives considered**:
- 复用会话 transcript 作为唯一存储：transcript 受会话文件生命周期、轮转与清理策略影响，且不承载摘要节点；删除历史 transcript 会连带丢失「无损」承诺。改为独立存储。
- 单个 JSON 数组文件：每次写入需重写整个文件，10k 条时 O(n) 写放大且崩溃易损坏。
- SQLite + FTS5：检索更快，但违反运行时可移植与零二进制依赖约束。

**演进预留**: 若后续需要更快检索，可在不改变 `messages.jsonl` 的前提下追加 `.index` 文件（v1 不实现）。

---

## R3. 集成点：post-sampling 捕获 + 压缩入口分流

**Decision**:
- 写入：在 `src/setup.ts` 用 `registerPostSamplingHook`（`src/utils/hooks/postSamplingHooks.ts:31`）注册增量落盘钩子。
- 压缩：在 `autoCompactIfNeeded`（`src/services/compact/autoCompact.ts:270`）的 session-memory 压缩之前、以及 `compactConversation`（`src/services/compact/compact.ts:411`）入口处分流到 lossless 引擎。

**Rationale**:
- post-sampling 钩子的入参已包含完整 `messages`、`toolUseContext`、`querySource`（`REPLHookContext`，同文件 `:11`），无需侵入 `query.ts` 主循环；SessionMemory 已用同一机制，风险与心智成本最低。
- 压缩只有一个「产出 `CompactionResult`」的契约（`compact.ts:305`），在其上游分流即可同时覆盖自动压缩、手动 `/compact` 与 reactive 压缩，REPL 与 headless 两侧无需改动。
- 分流点用懒 `require`（仓库既有写法，如 `autoCompact.ts:246`）避免 `compact → lossless → sideQuery → api/claude` 的模块环。

**Alternatives considered**:
- 在 `query.ts` 内直接改写 `messagesForQuery`：覆盖面最全，但要处理 7 个 `continue` 分支与投影时序，改动面与回归风险大。
- 只提供工具、不做自动压缩：无法解决「上下文超限」（SC-003），丢失主链路。

---

## R4. 摘要调用：复用 `sideQuery` 与当前 provider

**Decision**: 摘要通过 `sideQuery`（`src/utils/sideQuery.ts:178`）发起，`querySource: 'lossless_summary'`；默认模型取当前会话主模型，允许 `lossless.summaryModel` 覆盖。

**Rationale**:
- `sideQuery` 已屏蔽 firstParty / bedrock / vertex / openai / gemini / grok 差异，并复用现有鉴权与重试，天然满足「不引入独立密钥」。
- `QuerySource` 在 `src/constants/querySource.ts:6` 明确为自由字符串，新增标签零类型改动。
- 摘要失败必须可降级（FR-011），`sideQuery` 的 `optional` 选项与现有错误类型可直接复用。

**Alternatives considered**:
- 走 `runForkedAgent`：能复用缓存，但会引入额外的工具循环与副作用，摘要只需单次纯文本生成。
- 自建 provider 客户端：重复实现六套 provider 的鉴权与转换，直接违反单一实现原则。

---

## R5. 摘要结构：追加式 DAG（叶子 + 浓缩），不做可变树

**Decision**: 摘要节点只追加不原地修改。节点记录 `depth`、`childNodeIds`、覆盖的消息 id 范围与文本；浓缩节点引用子节点 id。重建视图时按 `depth` 自顶向下拼装。

**Rationale**:
- 追加式与 JSONL 存储天然契合，崩溃后不会出现「树结构半更新」。
- 参考上游的 leaf/condensed 两级扇出参数（默认叶子最少 8 条、浓缩最少 4 个），但节点本身更简单：不需要编辑器状态与跨会话移植。
- 检索命中节点时可沿 `childNodeIds` 逐层展开到原文，满足 FR-005 的「展开恢复」。

**Alternatives considered**:
- 可变树（原地重写节点）：需要事务与版本号，JSONL 上实现复杂，收益仅是可编辑性（v1 不需要）。
- 单层摘要（只有一级）：层数不足时无法在固定预算内压缩超长历史（SC-005）。

---

## R6. 检索实现：分块扫描 + 惰性缓存

**Decision**: `messages.jsonl` 按 1MB 分块读取，先做大小写无关的子串预筛，命中行再 `JSON.parse`；对最近 N 条消息保留解析缓存。展开时按 `tokenEstimate` 截断到 `maxExpandTokens`（默认 4000）。

**Rationale**:
- 目标规模下单次全量扫描成本可接受，避免为 v1 引入索引维护与失效逻辑。
- 只解析命中行，避免 50MB 文件全量 `JSON.parse` 的内存峰值。
- 截断保证展开不会反噬上下文预算。

**Alternatives considered**:
- 全量载入内存索引：内存占用与启动延迟随会话增长，且与「打开就为零成本」的关闭语义冲突（虽然仅开启时生效，但仍不必要）。
- FTS5：见 R2。

---

## R7. 门控：编译期 flag + 运行时设置双层

**Decision**: 新增 `LOSSLESS` 编译期 feature（`build.ts` / `scripts/defines.ts`），并在设置中新增 `lossless` 对象做运行时开关。关闭时：不注册钩子、不注入工具、不建目录。

**Rationale**:
- 仓库约定新功能走 `feature()`，构建期可整体剔除；运行时设置负责用户级/项目级/环境变量/会话命令四级控制（FR-001）。
- 钩子注册采用「无条件注册、钩子内惰性判断」还是「按设置注册」需要权衡：设置可能在会话中被 `/lossless on` 改变，因此选择「按 flag 注册、钩子内实时判断 `isLosslessEnabled()`」，保证会话内开启立即生效（FR-010）。

**Alternatives considered**:
- 仅运行时设置：从外部构建中无法剔除代码，与仓库约定不符。
- 仅编译期 flag：用户无法在不重新构建的情况下开启。

---

## R8. 与现有压缩机制共存

**Decision**: 开启后 lossless 接管上下文管理：跳过 session-memory 压缩（它会裁剪消息），保留手动 `/compact` 入口但产出 DAG 摘要；reactive 压缩（prompt too long）仍作为兜底。

**Rationale**:
- session-memory 压缩会裁剪消息数组，与「原文必须全部保留」冲突；但原文已在 store 中，裁剪只影响送入模型的消息，因此仍可安全跳过。
- reactive 压缩是 413 兜底，保留可避免「摘要失败 + 超限」时直接失败（FR-011）。

**Alternatives considered**:
- 与 session-memory 并行：两套裁剪策略叠加会让「保留哪些消息」不可预测，测试面翻倍。

---

## R9. 大块工具结果

**Decision**: 单条消息估算 token 超过 `largeFileTokenThreshold`（默认 25000）时，store 记录其完整内容与摘要标记，装配上下文时只放摘要与引用 id；展开工具可按 id 取回原文。

**Rationale**: 与 FR-009 对齐，且避免把整块内容塞回活动上下文；仓库已有大结果落盘机制（`src/utils/toolResultStorage.ts`），本特性只在其上增加「摘要 + 可检索引用」，不重复实现落盘。

**Alternatives considered**: 直接复用现有 persisted-output 引用而不做摘要——模型只能看到文件路径，无法语义检索，不满足 FR-005。

---

## R10. 许可与上游追踪

**Decision**: 在 `src/services/lossless/README.md` 记录参考的上游版本、能力映射表与 MIT 许可声明；不复制上游源码，只参考行为。

**Rationale**: 满足 FR-015，同时避免「copy 半份实现」导致的许可证头与维护分叉问题。

**Alternatives considered**: 直接 vendored 上游源码——上游代码强依赖宿主 API，裁剪量大于重写量。
