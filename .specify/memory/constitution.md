# Claude Code Fork Constitution

## Core Principles

### I. 规格先行（Spec Before Code）

任何非平凡改动必须先有 `specs/<feature>/spec.md`，并经过 clarify 消解高影响歧义后再进入 plan / tasks / implement。规格描述「用户可感知的行为与验收标准」，实现细节留在 plan 与研究文档中。没有验收标准的改动不得进入实现。

### II. 小步可验证交付（Incremental, Verifiable Delivery）

实现必须拆成多个可独立验证的批次，每个批次对应一个 PR，新增代码不超过 500 行。每批结束后由用户确认提交，确认后才开始下一批。每个批次必须能独立通过类型检查与相关测试，且不得留下「功能半成品但对用户可见」的中间状态。

### III. 实现后自动 CR（Automated Change Request）

`/speckit.implement` 完成后必须执行 `.specify/extensions.yml` 中注册的 `after_implement` 钩子（`git-auto-cr`），自动完成提交、推送与 CR 创建，并向用户返回可点击的 diff 链接。契约如下：

1. **只提交已暂存内容**：钩子只处理本次实现 `git add` 的文件，禁止把无关的工作区改动一并提交。
2. **分支策略**：当前在 `main` / `master` 时，先创建 `spec/<feature>` 分支再提交；**禁止 force push**，禁止改写已有历史。
3. **CR 创建**：存在 `GITHUB_TOKEN` 或 `GH_TOKEN` 时通过 GitHub API 创建 PR，返回 `pr_url` 与 `diff_url`；无 token 时推送分支并返回 compare 链接（同时是 diff 视图与创建 PR 的入口）。
4. **失败处理**：推送或 API 失败时保留本地提交，原样报告错误、commit 哈希与已尝试的命令；**禁止伪造或猜测链接**。
5. **凭据安全**：token 优先从 `GITHUB_TOKEN` / `GH_TOKEN` 读取；未配置时可显式使用 `--use-git-credential` 从本机 git credential helper 获取（默认关闭）。无论来源如何，禁止写入仓库、日志或提交信息。
6. **可追溯**：结果写入 `.specify/cr-result.json`（`status`、`branch`、`commit`、`pr_url`、`diff_url`），供后续命令引用。

钩子实现：`.specify/scripts/python/auto_cr.py`；注册文件：`.specify/extensions.yml`。

### IV. 质量门禁不可绕过（Quality Gates）

每个批次提交前必须满足：`bun run typecheck` 零错误、相关 `bun test` 通过、Biome 检查通过。任何触及 `feature()` 的改动必须额外用 `bun build --target=bun --production src/main.tsx` 验证（`tsc` 无法捕获该宏的位置限制）。生产代码禁止 `as any`。

### V. 本地优先与隐私（Local-first, Privacy-preserving）

涉及对话历史的持久化默认只写本地用户目录，文件权限为当前用户可读；不得上传或同步到远端。关闭特性时必须零新增文件、零新增请求。

### VI. 注释一律使用中文（Chinese Comments）

1. 新增或修改的代码注释必须使用中文，包括行内注释、块注释、文档注释（doc comment）、TODO / FIXME 说明。
2. 本次改动触及的文件，若原有注释为英文，必须在同一批次内一并改写为中文；不得在同一文件内留下中英混排的注释。
3. **保持原文的内容**：代码标识符、API / 命令名称、协议字段、错误信息字符串、日志键名、外部链接与第三方 license 头不译。
4. **例外范围**：自动生成的产物、vendored 第三方代码、上游 license 声明块、测试 snapshot 中的原文保持不变。
5. 中文注释应说明「为什么」，避免复述代码字面；一行能讲清就不写多行。

### VII. 每个批次的函数说明（Function Specs）

1. 每个批次（= 一个 PR）必须随代码提交一份函数说明：`specs/<feature>/function-specs/batch-<序号>-<主题>.md`。
2. 覆盖本批次**新增或实质修改的每个函数**（含内部辅助函数与方法），每个函数必须写清五项：
   - **签名与职责**：一句话说明它只做什么。
   - **输入示例**：真实形状的数据（不是占位符），含关键字段。
   - **输出示例**：真实形状的返回值或副作用结果。
   - **为什么这样设计**：为什么选这个边界/粒度/数据结构，拒绝了哪种更简单的替代方案。
   - **输入 → 处理 → 输出**：分步说明对输入做了什么（裁剪、归一化、去重、截断等），以及如何变成输出；包含失败与边界路径。
3. 说明使用中文（遵循原则 VI）；示例可用 JSON / 表格 / 伪调用形式，但必须能对应到真实类型。
4. 未附函数说明的批次不得提 PR；review 时逐项核对五项是否齐全。
5. 该说明是设计记录，不是 API 文档：不需要罗列全部参数类型，但必须解释「为什么」与「怎么变过去的」。

## 自动化 CR 契约（operational detail）

```text
触发器：hooks.after_implement（optional: false）
命令：  python3 .specify/scripts/python/auto_cr.py --from-hook
输出：  JSON —— status / branch / commit / pr_url / diff_url / error
副作用：本地 commit、远端分支推送、可选 PR 创建、写 .specify/cr-result.json
```

钩子失败不阻塞代码落盘：本地提交已生成即视为「代码已保存」，CR 链接缺失必须在报告中显式说明原因。

## 开发流程

```text
/speckit.specify → /speckit.clarify → /speckit.plan → /speckit.tasks
→ /speckit.implement（每批 ≤500 行，用户确认后继续）
→ 自动 CR 钩子（提交 + 推送 + 返回 diff 链接）
→ 人工 review → 合并
```

## Governance

本宪法优先于个人偏好与临时约定。修订必须：(1) 在 PR 中说明动机；(2) 更新本文件的版本号与修订日期；(3) 若影响既有流程，同步更新 `.specify/extensions.yml` 与相关模板。所有批次提交与 review 必须核对本文件的七项原则；违反项必须在 PR 描述中给出理由与替代方案。

**Version**: 1.2.0 | **Ratified**: 2026-11-21 | **Last Amended**: 2026-11-21
