# Implementation Plan: Lossless-Claw 无损上下文适配开关

**Branch**: `002-lossless-lcm-switch` | **Date**: 2026-11-21 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-lossless-lcm-switch/spec.md`

## Summary

在现有压缩链路之外增加一个默认关闭的「无损上下文」模式：开启后每条消息先落本地追加日志，达到阈值时不再「总结后丢弃」，而是生成分层摘要节点（叶子 → 浓缩），组装上下文时用「摘要 + 近期原文」替代全量历史；同时向模型暴露三个回溯能力（检索 / 查看摘要覆盖范围 / 展开原文），并提供调用次数、超时、退避三类花费护栏与只读状态诊断。

技术路线为内建实现（B 方案）：不改造成插件宿主、不引入上游运行时依赖，参考 lossless-claw 的配置语义与上下文引擎分层思路。集成点收敛到两处既有压缩入口（自动压缩与手动 `/compact`），存储用追加式 JSONL（不引入 SQLite），摘要复用现有 provider 无关的 `sideQuery`。

## Technical Context

**Language/Version**: TypeScript 5.x，Bun 运行时（dev / build），构建产物同时要求可在 Node 运行（ESM，`"type": "module"`）

**Primary Dependencies**: 无新增第三方依赖。复用：`sideQuery`（`src/utils/sideQuery.ts:178`，provider 无关的旁路模型调用）、`getFsImplementation`（`src/utils/fsOperations.ts`）、zod v4 设置校验（`src/utils/settings/types.ts:1206` 的 `SettingsJson`）、`bun:test`

**Storage**: 追加式 JSONL，按会话隔离：`<claudeConfigHome>/lossless/<projectDirName>/<sessionId>/{messages.jsonl,nodes.jsonl,meta.json}`。不使用 SQLite（`bun:sqlite` 在 Node 产物中不可用；`better-sqlite3` 需原生编译，违反「无新增二进制依赖」约束）

**Testing**: `bun:test`；单元测试放 `src/services/lossless/__tests__/`，工具测试放 `packages/builtin-tools/src/tools/LosslessTool/__tests__/`；集成测试复用 `tests/integration/` 现有模式

**Target Platform**: CLI（macOS / Linux / Windows），单机单用户，本地文件系统

**Project Type**: CLI（单仓 + Bun workspace 包）

**Performance Goals**: 1 万条历史消息下检索 p95 < 1s（SC-004）；`/lossless status` < 200ms；摘要调用单次超时 60s（可配）

**Constraints**: 关闭时零新增文件、零新增请求（SC-001）；生产代码禁止 `as any`；`bun run typecheck` 零错误；任何 `feature()` 改动必须用 `bun build --target=bun --production src/main.tsx` 验证（tsc 无法捕获宏的位置限制）；每个 PR 新增代码 ≤500 行且需人工确认后再继续（FR-016）

**Scale/Scope**: 单会话 ≤10k 条消息、≤50MB 存储；不覆盖多进程共享库（见 spec 的 Out of Scope）

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` 仍未填充（全部为占位符），无正式批准的治理条款。因此门禁回退到仓库既有硬约束，逐条核对：

| 门禁（来自 AGENTS.md / CLAUDE.md） | 结论 | 依据 |
|---|---|---|
| TypeScript strict，`bun run typecheck` 零错误 | PASS | 设计全部为纯 TS，无 `as any`；跨包只新增类型导出 |
| 生产代码禁止 `as any` | PASS | 存储记录用 `Record<string, unknown>` + 类型守卫收窄；工具输入用 zod |
| 新功能走 `feature()` 宏 + 运行时开关 | PASS | 新增 `LOSSLESS` flag（编译期剔除法）+ `lossless.enabled` 设置（运行时） |
| `feature()` 只能出现在 `if` 条件，且必须用真实构建验证 | PASS（流程约束） | plan 将 `bun build` 写入每个相关 PR 的验收步骤 |
| 不新增需要另行安装的二进制 / 外部服务 | PASS | JSONL + 现有 fs 抽象；无 SQLite、无守护进程 |
| 可独立回滚、单 PR 可验证 | PASS | 6 个批次，每批独立可跑；见「交付批次」 |

无违规项，Complexity Tracking 留空。

## Project Structure

### Documentation (this feature)

```text
specs/002-lossless-lcm-switch/
├── plan.md              # 本文件
├── research.md          # Phase 0：关键技术决策与备选对比
├── data-model.md        # Phase 1：实体、字段、状态迁移
├── quickstart.md        # Phase 1：端到端验证脚本
├── contracts/
│   ├── settings-schema.md   # 设置项契约（四级优先级）
│   ├── cli-lossless.md      # /lossless 命令契约
│   ├── tools.md             # 三个回溯工具的输入/输出契约
│   └── storage-format.md    # 磁盘格式契约（v1，可演进）
└── tasks.md             # /speckit.tasks 产出，不在本命令范围
```

### Source Code (repository root)

```text
src/
├── services/lossless/
│   ├── index.ts              # 对外门面：isLosslessEnabled / getStats / 内部入口
│   ├── settings.ts           # 四级优先级解析 + 会话内覆盖（对应 FR-001）
│   ├── store.ts              # JSONL 追加、读取、损坏行容错、schema 版本
│   ├── capture.ts            # post-sampling 钩子：增量落盘（FR-003）
│   ├── engine.ts             # 叶子分块 + 浓缩 + 债务累积（FR-004/FR-009）
│   ├── summarizer.ts         # sideQuery 摘要调用 + 超时/重试（FR-008）
│   ├── assembler.ts          # 摘要 + 新鲜尾巴 → CompactionResult（FR-004）
│   ├── retrieval.ts          # grep / describe / expand（FR-005/FR-006）
│   ├── guard.ts              # 调用窗口、退避、熔断（FR-008）
│   └── __tests__/            # 单测：store / guard / assembler / retrieval
├── services/compact/
│   ├── autoCompact.ts        # 修改：开启时在 session-memory 压缩之前分流
│   └── compact.ts            # 修改：手动 /compact 入口分流（懒加载避免环）
├── commands/lossless/
│   ├── index.ts              # 命令声明（type: 'local'）
│   └── lossless.ts           # status / on / off / doctor
├── commands.ts               # 修改：feature-gated 注册
├── setup.ts                  # 修改：注册 capture 钩子（与 session memory 同处）
├── tools.ts                  # 修改：按 isLosslessEnabled() 注入三个工具
└── utils/settings/types.ts   # 修改：新增 lossless 设置 schema

packages/builtin-tools/src/tools/LosslessTool/
├── LosslessGrepTool.ts
├── LosslessDescribeTool.ts
├── LosslessExpandTool.ts
├── prompt.ts                 # 工具描述与使用指引
└── __tests__/

scripts/defines.ts             # DEFAULT_BUILD_FEATURES 增加 LOSSLESS（编译期包含）
```

**Structure Decision**: 单项目结构。业务实现集中在 `src/services/lossless/`（与 `services/compact/`、`services/SessionMemory/` 平级，符合现有 service 组织方式）；模型可见工具放 `packages/builtin-tools`（与 SnipTool / CtxInspectTool 一致，便于按 flag 条件引入）；命令放 `src/commands/lossless/`（沿用 poor / goal 的 `index.ts` + 实现文件模式）。

## 集成设计（关键决策摘要，细节见 research.md）

1. **写路径**：`src/setup.ts` 注册一个 post-sampling 钩子（`registerPostSamplingHook`，见 `src/utils/hooks/postSamplingHooks.ts:31`），钩子内按 `uuid` 增量追加未落盘消息。与 SessionMemory 的注册方式一致，不侵入 `query.ts` 主循环。
2. **压缩路径**：`autoCompactIfNeeded`（`src/services/compact/autoCompact.ts:270`）在 `trySessionMemoryCompaction` 之前分流；`compactConversation`（`src/services/compact/compact.ts:411`）在函数入口分流，覆盖手动 `/compact`。两处都用懒 `require` 引用 lossless 引擎，避免 `compact → lossless → sideQuery → api/claude → compact` 的模块环。
3. **上下文装配**：复用 `CompactionResult`（`src/services/compact/compact.ts:305`）契约：`boundaryMarker` 用现有 compact boundary 构造，`summaryMessages` 放根摘要，`messagesToKeep` 放新鲜尾巴。这样 REPL 与 headless 两侧无需改动即可替换消息数组。
4. **摘要调用**：`sideQuery` + `querySource: 'lossless_summary'`（`QuerySource` 是自由字符串，见 `src/constants/querySource.ts:6`），模型默认取 `toolUseContext.options.mainLoopModel`，可用 `lossless.summaryModel` 覆盖。
5. **工具门控**：三个工具在 `getAllBaseTools()`（`src/tools.ts:219`）内条件注入，且各自 `isEnabled()` 返回 `isLosslessEnabled()`——关闭时不进入系统提示与工具列表（FR-002）。
6. **与 CONTEXT_COLLAPSE 的关系**：两者都改写上下文视图，同时启用会互相覆盖。设计为 lossless 优先：开启时 `shouldAutoCompact` 仍走阈值判断，但压缩由 lossless 接管；`/lossless status` 显式提示「已接管上下文管理」。

## 交付批次（每个 PR ≤500 行新增代码，用户确认后再继续）

| 批次 | 内容 | 覆盖需求 | 预估新增行 |
|---|---|---|---|
| P1 | `LOSSLESS` flag、设置 schema、四级优先级解析、`/lossless on\|off\|status` 骨架 | FR-001/FR-002/FR-016（分批） | ~380 |
| P2 | JSONL store + post-sampling 捕获 + meta 版本与损坏容错 | FR-003/FR-011/FR-012 | ~450 |
| P3 | 叶子分块 + 浓缩 + 债务累积 + 自动压缩分流 | FR-004/FR-009 | ~480 |
| P4 | 装配器 + 手动 `/compact` 分流 + boundary 兼容 | FR-004/FR-014 | ~400 |
| P5 | 检索/描述/展开 + 三个工具 + 工具注册 | FR-005/FR-006 | ~500 |
| P6 | 护栏（窗口/超时/退避/熔断）+ 状态字段补全 + 文档与许可归属 | FR-007/FR-008/FR-015 | ~450 |

每批结束时必须：`bun run typecheck` 零错误、相关 `bun test` 通过、`/lossless` 命令或压缩路径行为可人工复现；触及 `feature()` 的批次追加 `bun build --target=bun --production src/main.tsx`。

## Complexity Tracking

无违规项，本节留空。
