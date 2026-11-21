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

本宪法优先于个人偏好与临时约定。修订必须：(1) 在 PR 中说明动机；(2) 更新本文件的版本号与修订日期；(3) 若影响既有流程，同步更新 `.specify/extensions.yml` 与相关模板。所有批次提交与 review 必须核对本文件的五项原则；违反项必须在 PR 描述中给出理由与替代方案。

**Version**: 1.0.0 | **Ratified**: 2026-11-21 | **Last Amended**: 2026-11-21
