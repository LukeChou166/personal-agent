---
description: "Task list for Lossless-Claw 无损上下文适配开关"
---

# Tasks: Lossless-Claw 无损上下文适配开关

**Input**: Design documents from `specs/002-lossless-lcm-switch/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: 规格未要求 TDD，但仓库硬约束（AGENTS.md）要求改动附带 `bun:test`，且每个用户故事都有 Independent Test 判据，因此测试任务按「与服务实现同批」列入，不单独作为 TDD 前置。

**Organization**: 按用户故事分组，保证每个故事可独立实现与验证；交付批次与 PR 确认门见文末。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、无未完成依赖）
- **[Story]**: 所属用户故事（US1–US5）
- 每个任务都给出精确文件路径

## Path Conventions

单项目 + Bun workspace：`src/`（主程序）、`packages/builtin-tools/src/tools/`（模型可见工具）、`tests/`（集成测试）。

---

## Phase 1: Setup（共享基础设施）

**Purpose**: 打开编译期开关、声明设置 schema、建立目录与命令骨架

- [X] T001 在 `scripts/defines.ts` 的 `DEFAULT_BUILD_FEATURES` 中新增 `LOSSLESS`（带一行注释说明用途），并用 `bun build --target=bun --production src/main.tsx --outdir /tmp/lossless-build` 验证 `feature('LOSSLESS')` 调用合法
- [X] T002 [P] 在 `src/utils/settings/types.ts` 的 `SettingsSchema` 中新增 `lossless` 可选对象：字段与默认值严格按 `data-model.md` 的 `LosslessSetting` 表；数值约束（`contextThreshold` 0.1–0.99、`freshTailCount` 1–1000、`leafChunkTokens` ≥1000、`maxExpandTokens` ≤8000）必须写进 zod schema
- [X] T003 [P] 创建 `src/services/lossless/index.ts` 门面（导出 `isLosslessEnabled`、`getLosslessConfig`、`getLosslessStats` 占位实现，关闭态返回零值）与 `src/services/lossless/README.md`（记录参考上游版本/提交、能力映射表、MIT 许可声明，对应 FR-015）
- [X] T004 [P] 创建 `src/commands/lossless/index.ts`：`{ type: 'local', name: 'lossless', description: '...', supportsNonInteractive: true, load: () => import('./lossless.js') } satisfies Command`，`argumentHint` 为 `on|off|status|doctor`
- [X] T005 [P] 建立 `src/services/lossless/__tests__/` 并放入设置解析测试；`packages/builtin-tools/src/tools/LosslessTool/__tests__/` 在 PR-5 随工具一起建立

---

## Phase 2: Foundational（阻塞性前置）

**Purpose**: 开关解析、存储层与消息捕获——所有用户故事都依赖它们

**⚠️ CRITICAL**: 本阶段完成前，任何用户故事都无法端到端验证

- [X] T006 实现 `src/services/lossless/settings.ts`：`isLosslessEnabled()`、`getLosslessConfig()`、`getEffectiveSource()`、`setSessionOverride('on'|'off')`。优先级必须为「会话命令 > 环境变量（`CLAUDE_CODE_LOSSLESS`）> 项目本地 > 项目 > 用户 > 默认关闭」（FR-001）；来源判定复用 `getSettingsWithSources()`（`src/utils/settings/settings.ts:836`）；越界值收敛并在结果中标记 `clamped`
- [ ] T007 [P] 实现 `src/services/lossless/store.ts` 的路径与权限部分：`getStorePaths(sessionId)` 返回 `{dir,messages,nodes,meta}`，目录 `0700`、文件 `0600`；`projectKey` 复用现有项目目录命名（`src/utils/sessionStorage.ts:199` 的 `getProjectsDir()` 同源逻辑）；`LOSSLESS_DATABASE_PATH` 可覆盖根目录
- [ ] T008 实现 `src/services/lossless/store.ts` 的读写部分：`appendMessage(record)`、`appendNode(node)`、`readMessages(filter)`、`readNodes()`、`readMeta()`、`writeMetaAtomic()`。要求：单行 JSON 追加；解析失败行计入 `corruptLines` 并跳过（FR-011）；`meta.json` 用临时文件 + rename 原子替换；`schemaVersion: 1`
- [ ] T009 实现 `src/services/lossless/capture.ts`：post-sampling 钩子函数，按 `uuid`/`lastSeq` 去重写入新增消息；`tokenEstimate` 计算；单条超过 `largeFileTokenThreshold`（默认 25000）时标记 `large: true` 并写 `sourceRef`；命中 `ignoreSessionPatterns` 时不写，命中 `statelessSessionPatterns` 时只读
- [ ] T010 在 `src/setup.ts` 注册 capture 钩子（与 SessionMemory 初始化同处），采用 `registerPostSamplingHook`（`src/utils/hooks/postSamplingHooks.ts:31`）；钩子内首行调用 `isLosslessEnabled()`，关闭时立即返回且零 I/O（FR-002）
- [ ] T011 [P] 编写 `src/services/lossless/__tests__/store.test.ts`：追加/读取、截断行容错、`meta.json` 原子替换、目录/文件权限、`schemaVersion` 不匹配进入只读；关闭开关 MUST NOT 删除已有记录（FR-010）；存储不可写时降级为当前压缩行为且对话不中断（FR-011）
- [ ] T012 [P] 编写 `src/services/lossless/__tests__/capture.test.ts`：关闭态零写入零请求、重复 uuid 不重复写、`large` 标记与 `sourceRef`、排除/无状态模式
- [X] T013 实现 `src/commands/lossless/lossless.ts` 的 `on|off|status|help`：`on/off` 仅设会话覆盖并提示「下一轮生效」，`--save` 写入用户级设置（`updateSettingsForSource('userSettings', ...)`）；`status` 输出 `contracts/cli-lossless.md` 的稳定字段；在 `src/commands.ts` 中以 `feature('LOSSLESS')` 条件注册
- [X] T014 [P] 编写 `src/services/lossless/__tests__/settings.test.ts`：四级优先级、环境变量覆盖、会话覆盖、来源字段、越界收敛

**Checkpoint**: 关闭态零副作用可测；开启后消息可落盘；`/lossless status` 可读出真实状态。

---

## Phase 3: User Story 1 — 一个开关切换到「不再丢历史」的对话模式 (P1) 🎯 MVP

**Goal**: 开启后旧消息被分层摘要替代，原文全量留存，上下文不超限（FR-003/FR-004/FR-009/FR-011）

**Independent Test**: 开启开关跑超过阈值的会话，确认出现 `depth:1`（必要时 `depth:2`）节点、对话继续可用、无上下文超限错误；关闭后行为与现状一致。

- [ ] T015 [US1] 在 `src/services/lossless/engine.ts` 实现消息级 token 估算与叶子分块：按 `leafChunkTokens`（默认 20000）聚合、`leafMinFanout`（默认 8）控制最少条数，产出待摘要块与 `span {firstSeq,lastSeq}`
- [ ] T016 [US1] 在 `src/services/lossless/summarizer.ts` 实现摘要调用：`sideQuery`（`src/utils/sideQuery.ts:178`），`querySource: 'lossless_summary'`，模型取 `toolUseContext.options.mainLoopModel` 或 `lossless.summaryModel`，`max_tokens` 取 `leafTargetTokens`，超时取 `summaryTimeoutMs`，失败返回结构化错误不抛出到主循环
- [ ] T017 [US1] 在 `engine.ts` 写入 leaf 节点到 `nodes.jsonl`：`kind:'leaf'`、`depth:1`、`span`、`messageIds`（未超限时）、`text`、`tokenEstimate`、`model`、`status:'active'`；校验规则按 `data-model.md` 第 4 节
- [ ] T018 [US1] 在 `engine.ts` 实现浓缩层：当同深度节点数 ≥ `condensedMinFanout`（默认 4）时生成 `kind:'condensed'` 节点，`childNodeIds` 至少 2 个且深度为 `depth-1`；`incrementalMaxDepth` 控制每轮新增层数（`0` 仅叶子、`-1` 不限）
- [ ] T019 [US1] 在 `engine.ts` 维护 `meta.backlog`（`pendingMessages`、`pendingNodes`、`failures`、`nextRetryAt`、`lastError`、`tripped`），失败 3 次后置 `tripped` 并停止自动重试
- [ ] T020 [US1] 实现 `src/services/lossless/assembler.ts`：产出 `CompactionResult`（`src/services/compact/compact.ts:305`），`boundaryMarker` 复用现有 compact boundary 构造，`summaryMessages` 放根摘要（按 depth 自顶向下），`messagesToKeep` 放最近 `freshTailCount` 条原文并按预算截断；`large: true` 的消息只放摘要与 `sourceRef` 引用，不把原文塞回活动上下文（FR-009）
- [ ] T021 [US1] 在 `src/services/compact/autoCompact.ts` 的 `autoCompactIfNeeded` 中、`trySessionMemoryCompaction` 之前分流：`isLosslessEnabled()` 为真时懒 `require` lossless 引擎并返回其结果；关闭时保持原路径不变（FR-002/FR-014）
- [ ] T022 [P] [US1] 编写 `src/services/lossless/__tests__/engine.test.ts` 与 `assembler.test.ts`：叶子扇出与 span、浓缩深度约束、`freshTailCount` 保护、预算截断、失败态 `tripped`

**Checkpoint**: MVP 成立——开关开启即「不再丢历史 + 继续可用」。

---

## Phase 4: User Story 2 — 模型能回溯到被压缩前的原文 (P1)

**Goal**: 三个检索能力可被模型主动调用，且严格会话隔离（FR-005/FR-006）

**Independent Test**: 在被压缩的会话中问一个只出现在早期的唯一标识，模型能检索并展开出原文。

- [ ] T023 [US2] 实现 `src/services/lossless/retrieval.ts` 的 `grep(pattern, {limit, role, nodeId})`：1MB 分块扫描 `messages.jsonl`，大小写无关预筛，仅解析命中行；返回 `RetrievalHit[]` 与 `scanned_messages`；`limit` 1–50 默认 20
- [ ] T024 [US2] 实现 `retrieval.ts` 的 `describe(nodeId)`：返回节点元数据、最多 20 个子节点、`expandable_tokens`；`corrupt` 节点只返回元数据不抛错
- [ ] T025 [US2] 实现 `retrieval.ts` 的 `expand({nodeId|messageIds, maxTokens})`：按 `seq` 正序拼装，每条前缀 `[seq/uuid/role]`，超过 `maxExpandTokens`（默认 4000，上限 8000）截断并返回 `next.start_seq`
- [ ] T026 [P] [US2] 创建 `packages/builtin-tools/src/tools/LosslessTool/LcmGrepTool.ts`：zod 输入 `{pattern, limit?, role?, node_id?}`，`isEnabled()` 返回 `isLosslessEnabled()`，`isReadOnly()` 为 true，`searchHint: 'search history transcript recall earlier messages keywords'`
- [ ] T027 [P] [US2] 创建 `packages/builtin-tools/src/tools/LosslessTool/LcmDescribeTool.ts`：输入 `{node_id}`，输出按 `contracts/tools.md` 第 2 节
- [ ] T028 [P] [US2] 创建 `packages/builtin-tools/src/tools/LosslessTool/LcmExpandTool.ts`：输入 `{node_id?, message_ids?, max_tokens?}`，输出按 `contracts/tools.md` 第 3 节
- [ ] T029 [P] [US2] 创建 `packages/builtin-tools/src/tools/LosslessTool/prompt.ts`：三个工具的描述与使用指引（先 grep 后 expand；展开消耗上下文；引用时给出 seq/uuid）
- [ ] T030 [US2] 从 `packages/builtin-tools/src/index.ts` 导出三个工具，并在 `src/tools.ts` 的 `getAllBaseTools()`（`:219`）中以条件展开注入；关闭时三个工具不得出现在工具列表（FR-002）
- [ ] T031 [P] [US2] 编写 `src/services/lossless/__tests__/retrieval.test.ts`（命中/无命中/截断/跨会话拒绝/corrupt 节点）与 `packages/builtin-tools/src/tools/LosslessTool/__tests__/tools.test.ts`（输入校验、输出结构）

**Checkpoint**: 「无损」可被验证——模型能取回原文，而非只能看摘要。

---

## Phase 5: User Story 3 — 开关状态与运行状况随时可见 (P2)

**Goal**: 只读状态与诊断，200ms 内返回，不改数据（FR-007）

**Independent Test**: 开启/关闭/存储不可用三种状态下执行 `status`，输出与实际一致；篡改一行后 `doctor` 能报告且不修复。

- [ ] T032 [US3] 在 `src/commands/lossless/lossless.ts` 补全 `status` 全部字段：开关与来源、存储路径与占用、节点数与分层分布、待压缩数量与失败次数与重试时间、护栏窗口用量、摘要模型是否为覆盖值（字段清单见 `contracts/cli-lossless.md`）
- [ ] T033 [US3] 实现 `doctor`：扫描 `messages.jsonl` 损坏行数、节点缺失子节点、span 缺口/重叠；只输出报告，不写盘、不发模型调用
- [ ] T034 [US3] 保证 `status` 只读 `meta.json` 计数、不做正文全量扫描；存储不可读时输出 `store: unavailable (<reason>)` 且退出码 0
- [ ] T035 [P] [US3] 编写 `src/commands/lossless/__tests__/status.test.ts`：字段快照、OFF 态文案、不可写降级、`doctor` 对篡改数据的报告

**Checkpoint**: 用户能观测与止损，无需整体关掉功能。

---

## Phase 6: User Story 4 — 成本与隐私护栏 (P2)

**Goal**: 摘要调用可控、会话可排除、数据只在本地且仅本人可读（FR-008/FR-012/FR-013）

**Independent Test**: 把 `summaryMaxCallsPerWindow` 设为 1，第二次摘要被拒绝并提示且对话不中断；被排除会话零记录。

- [ ] T036 [US4] 实现 `src/services/lossless/guard.ts`：窗口计数（`summaryCallWindowMs`）、单次超时（`summaryTimeoutMs`）、冷却（`summarySpendBackoffMs`）、熔断（连续 3 次失败）；状态持久化到 `meta.guard`，状态迁移按 `data-model.md` 第 6 节
- [ ] T037 [US4] 在 `summarizer.ts` 调用前接入 guard：被拒绝时不发请求、累加 backlog、返回一次可见提示（同一轮不重复提示）
- [ ] T038 [US4] 在 `capture.ts` 与 `engine.ts` 落实会话排除：`ignoreSessionPatterns` 完全不记录且不摘要，`statelessSessionPatterns` 可读不写；pattern 语义为 `*` 不跨 `:`、`**` 跨 `:`、按完整 session key 匹配
- [ ] T039 [US4] 校验本地化与权限：所有写入路径位于用户配置目录，目录 `0700`、文件 `0600`；新增断言确认不产生任何网络请求（除 `lossless_summary` 摘要在开启时）；新增跨项目用例：项目 A 开启、项目 B 未开启时 B 零文件零请求且检索不串数据（SC-010）；非 POSIX 平台记录 ACL 差异
- [ ] T040 [P] [US4] 编写 `src/services/lossless/__tests__/guard.test.ts` 与 `exclusion.test.ts`：窗口上限、冷却、熔断、pattern 匹配、零网络断言

**Checkpoint**: 护栏与隐私承诺可测，用户可放心长期开启。

---

## Phase 7: User Story 5 — 与现有会话工作流兼容 (P3)

**Goal**: 手动压缩、会话恢复、各 provider 均可正常工作（FR-014）

**Independent Test**: 开启态下依次执行手动 `/compact`、`--resume`、切换 provider，行为与历史检索结果一致。

- [ ] T041 [US5] 在 `src/services/compact/compact.ts` 的 `compactConversation`（`:411`）入口分流：`isLosslessEnabled()` 为真时懒 `require` lossless 装配器，返回 DAG 摘要版 `CompactionResult`；关闭时不改变任何路径（FR-014）
- [ ] T042 [US5] 校验会话恢复：确认 store 以 `getSessionId()` 定位、`--resume`/branch 后仍可检索（不实现回填）；在 `src/services/lossless/store.ts` 暴露 `hasSession(sessionId)`
- [ ] T043 [US5] 校验 provider 兼容：摘要走 `sideQuery` 对 `CLAUDE_CODE_USE_OPENAI` / `GEMINI` / `GROK` 路径的 mock 测试，确认无 firstParty 专属字段
- [ ] T044 [P] [US5] 编写 `tests/integration/lossless-compat.test.ts`：手动压缩产出 DAG 节点、恢复后计数一致、provider 切换不破坏摘要调用、100 轮长会话无上下文超限失败（SC-003）

**Checkpoint**: 老工作流不被破坏，特性能长期开启。

---

## Phase 8: Polish & Cross-Cutting

**Purpose**: 文档、许可、性能与全量回归

- [ ] T045 [P] 编写 `docs/features/lossless-context.md`：能力说明、开关方式、费用与隐私、故障排查（引用 `quickstart.md` 场景）
- [ ] T046 [P] 在 `src/services/lossless/README.md` 补齐上游版本/提交、能力映射表与 MIT 许可声明（FR-015）
- [ ] T047 增加 10k 消息规模的检索基准测试（`src/services/lossless/__tests__/perf.test.ts`），断言 p95 < 1s（SC-004）；同时断言常驻上下文压缩比 ≥10:1、存储体积随消息数线性增长（SC-005）
- [ ] T048 全量回归：`bun run typecheck`、`bun run lint`、`bun test`、触及 `feature()` 的改动追加 `bun build --target=bun --production src/main.tsx`；核对关闭态零副作用四条断言（`contracts/settings-schema.md` 第 4 节）

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 无依赖，可立即开始
- **Foundational (Phase 2)**: 依赖 Phase 1；**阻塞所有用户故事**
- **US1 (Phase 3)**: 依赖 Foundational
- **US2 (Phase 4)**: 依赖 Foundational 的 store（T007/T008），不依赖 US1 的摘要实现
- **US3 (Phase 5)**: 依赖 Foundational 的 store/meta；`doctor` 的节点校验依赖 US1 产生的节点
- **US4 (Phase 6)**: 依赖 Foundational + US1 的 `summarizer.ts`
- **US5 (Phase 7)**: 依赖 US1 的 `assembler.ts`
- **Polish (Phase 8)**: 依赖全部

### Story Completion Order

```text
Setup → Foundational ─┬─→ US1 (P1, MVP) ─┬─→ US4
                      ├─→ US2 (P1)        └─→ US5
                      └─→ US3 (P2)
```

US1 与 US2 可并行（不同文件：`engine.ts`/`assembler.ts` vs `retrieval.ts`/`LosslessTool/`）。

### Within Each Story

- 服务实现先于工具/命令接线；测试与服务同批提交（仓库要求同批验证）
- 同一文件内的任务串行（`engine.ts` 的 T015→T017→T018→T019 不得并行）

### Parallel Opportunities

- Phase 1：T002 / T003 / T004 / T005 可并行
- Phase 2：T007 与 T011 / T012 / T014 可并行
- Phase 4：T026 / T027 / T028 / T029 四个文件可并行
- Phase 3 与 Phase 4 之间可按文件并行（`engine.ts` vs `retrieval.ts`）

## Parallel Example: User Story 2

```bash
# 三个工具文件互不依赖，可同时创建：
Task: "LcmGrepTool.ts in packages/builtin-tools/src/tools/LosslessTool/"
Task: "LcmDescribeTool.ts in packages/builtin-tools/src/tools/LosslessTool/"
Task: "LcmExpandTool.ts in packages/builtin-tools/src/tools/LosslessTool/"
```

---

## PR 批次与确认门（FR-016 / SC-009）

每个 PR 新增代码 ≤500 行；**完成后必须停下来等用户确认提交，再开始下一批**。

| PR | 任务 | 主题 | 预估新增行 |
|---|---|---|---|
| PR-1 | T001–T006, T013, T014 | flag + 设置解析 + 命令骨架 | ~490（已完成） |
| PR-2 | T007–T012 | 存储层 + 捕获钩子 | ~440 |
| PR-3 | T015–T019 | 分层摘要（叶子/浓缩/债务） | ~480 |
| PR-4 | T020–T022 | 装配器 + 自动压缩分流 | ~430 |
| PR-5 | T023–T031 | 检索 + 三个工具 | ~500 |
| PR-6 | T032–T035 | 状态与只读诊断 | ~330 |
| PR-7 | T036–T040 | 护栏 + 排除 + 隐私 | ~450 |
| PR-8 | T041–T044 | 兼容（手动压缩/恢复/provider） | ~380 |
| PR-9 | T045–T048 | 文档 + 性能 + 全量回归 | ~300 |

每批提交前执行：`bun run typecheck`、相关 `bun test`、`git --no-pager diff --stat`（确认新增行数）；触及 `feature()` 的批次追加 `bun build --target=bun --production src/main.tsx`。

---

## Implementation Strategy

### MVP First（US1 交付即可演示）

1. Phase 1 + Phase 2（基础设施）
2. Phase 3（US1：留存 + 分层摘要 + 自动压缩分流）
3. **STOP and VALIDATE**：跑 `quickstart.md` 第 2、3 节
4. 用户确认后进入 US2

### Incremental Delivery

1. PR-1/PR-2 → 关闭态零副作用 + 可落盘
2. PR-3/PR-4 → US1 成立（MVP）
3. PR-5 → US2 成立（可回溯）
4. PR-6/PR-7 → 可观测与可控成本
5. PR-8 → 兼容既有工作流
6. PR-9 → 收尾与回归

## 需求覆盖矩阵

### Functional Requirements → 任务

| 需求 | 覆盖任务 |
|---|---|
| FR-001 四级控制来源与优先级 | T006, T013, T014 |
| FR-002 关闭态零副作用 | T012, T010, T030, T048 |
| FR-003 全量持久化 | T008, T009, T011 |
| FR-004 分层摘要替代丢弃式压缩 | T015–T020, T021 |
| FR-005 三种回溯能力 | T023–T025, T026–T030 |
| FR-006 会话隔离 | T023–T025, T031 |
| FR-007 状态与只读诊断 | T032–T035 |
| FR-008 成本护栏 | T036, T037, T040 |
| FR-009 大块内容隔离与摘要 | T009, T020 |
| FR-010 下一轮生效、关闭不删数据 | T006, T013, T011 |
| FR-011 失败降级不丢数据 | T008, T016, T034, T011 |
| FR-012 仅本地、仅本人可读 | T007, T039 |
| FR-013 会话排除策略 | T009, T038, T040 |
| FR-014 与既有压缩/恢复/会话记忆共存 | T021, T041–T044 |
| FR-015 上游版本与 MIT 归属 | T003, T046 |
| FR-016 分批交付（≤500 行/PR） | 「PR 批次与确认门」表（流程约束，非代码任务） |
| FR-017 项目级不写仓库、不串项目 | T007, T039 |

### Success Criteria → 验证任务

| 成功标准 | 验证位置 |
|---|---|
| SC-001 关闭态零文件零请求 | T012, T048 |
| SC-002 20 条早期消息 3 步内还原 | T031, T044 |
| SC-003 100 轮无超限失败 | T044 |
| SC-004 检索 p95 < 1s | T047 |
| SC-005 压缩比 ≥10:1、存储线性增长 | T047 |
| SC-006 护栏触发后 1 轮内停止 | T040 |
| SC-007 重启后检索一致 | T044 |
| SC-008 1 分钟内完成开关闭环 | `quickstart.md` 第 2 节 + T048 人工复核 |
| SC-009 每批 ≤500 行且独立可验证 | 「PR 批次与确认门」表（流程约束） |
| SC-010 跨项目隔离 | T039 |

## Notes

- [P] 任务 = 不同文件、无未完成依赖
- 同一文件的可变状态（`meta.json`）写入必须串行，不得并行
- 每个批次结束都是可运行状态，不产生「半成品用户可见」
- 关闭态的零副作用断言优先于任何新功能测试
