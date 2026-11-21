# Quickstart: 验证 Lossless 开关

**Feature**: `002-lossless-lcm-switch` | **Date**: 2026-11-21

本文件是端到端验证指南，不包含实现代码。字段与格式细节见 `contracts/`，实体定义见 `data-model.md`。

## 0. 前置条件

```bash
cd /Users/zhouli/Documents/work_space/claude-code
bun install
bun run typecheck        # 基线必须零错误
bun test src/services/lossless   # 批次完成后应存在
```

需要一个可用的模型 provider（沿用当前 `/login` 配置）。若想快速触发压缩而不跑长篇对话，把阈值调小：

```bash
export CLAUDE_CODE_LOSSLESS=1
export LOSSLESS_CONTEXT_THRESHOLD=0.2   # 也可写进 settings.json 的 lossless.contextThreshold
```

## 1. 关闭时零副作用（SC-001 / FR-002）

```bash
rm -rf ~/.claude/lossless
bun run dev -- --help >/dev/null
ls ~/.claude/lossless 2>/dev/null && echo "FAIL: store created" || echo "PASS: no store"
bun -e "import { getAllBaseTools } from './src/tools.ts'; const n=getAllBaseTools().map(t=>t.name); console.log(n.filter(x=>x.startsWith('Lcm')))"
```

期望：无 `lossless` 目录；工具列表不含 `LcmGrep` / `LcmDescribe` / `LcmExpand`；会话期间无 `lossless_summary` 请求（可通过 `--debug` 日志确认）。

## 2. 开启并观察落盘（FR-003 / FR-010）

```bash
bun run dev
# 会话内：
/lossless status        # 期望 lossless: OFF (source: default)
/lossless on --save
/lossless status        # 期望 ON (source: user)，并提示「下一轮生效」
```

进行 3–5 轮包含工具调用的对话，然后：

```bash
find ~/.claude/lossless -type f | sort
wc -l ~/.claude/lossless/*/*/messages.jsonl
```

期望：出现 `messages.jsonl` / `nodes.jsonl` / `meta.json`；行数等于对话消息数（含工具结果）；`meta.json` 的 `lastSeq` 与实际行数一致。

新开会话（不带 `--resume`）确认互不干扰：新目录独立创建，`/lossless status` 显示 0 条记录。

## 3. 触发分层摘要（FR-004 / FR-009 / SC-005）

把阈值调小后继续对话，直到 `/lossless status` 出现：

```text
summaries: N nodes (depth 1: a, depth 2: b)
backlog: 0 messages pending, 0 failures
```

期望：
- `nodes.jsonl` 至少出现一个 `depth: 1` 的叶子节点，且其 `span` 覆盖早期消息。
- 当叶子数达到 `condensedMinFanout`（默认 4）时出现 `depth: 2` 节点。
- 对话继续可用，不出现上下文超限错误（SC-003）。
- 注入一段超阈值的大块工具结果（例如读取一个 ~60KB 文件），确认该条记录 `large: true`，且装配时只放摘要。

## 4. 回溯原文（SC-002 / SC-007 / FR-005）

1. 在第 1 轮输入一个唯一标识（如 `ZQ-7f3a-lossless-probe`），之后让会话充分压缩。
2. 在第 N 轮提问：「`ZQ-7f3a-lossless-probe` 出现在哪一轮？原文是什么？」
3. 期望模型调用 `LcmGrep` 命中 `seq`，再用 `LcmExpand` 还原该行原文，回答包含完整标识与上下文。

重启验证：

```bash
bun run dev -- --resume <session-id>
```

`/lossless status` 计数应与重启前一致；重复上面的提问，检索结果不变（SC-007）。

## 5. 花费护栏（FR-008 / SC-006）

```bash
# 在 settings.json 中临时设置
# "lossless": { "summaryMaxCallsPerWindow": 1, "summarySpendBackoffMs": 600000 }
```

制造需要两次以上摘要的对话，期望：
- 第二次摘要被拒绝，`/lossless status` 显示 `guard: 1/1 calls in window, backoff: 9m`。
- 对话不中断，`backlog.messageCount` 增长。
- 连续失败 3 次后 `tripped: true`，不再自动重试。

## 6. 跨项目隔离（SC-010 / FR-017）

```bash
cd /path/to/project-a && bun run dev     # /lossless on --save
cd /path/to/project-b && bun run dev     # /lossless status 应为 OFF 或继承用户级设置
```

- 项目 B 未开启时：其会话目录不存在，`messages.jsonl` 不创建，无摘要请求。
- 在项目 B 中调用 `LcmGrep` 检索项目 A 的独特标识，必须 0 命中。
- 确认 `~/.claude/lossless` 不在任何仓库工作区内，`git status` 无新增文件。

## 7. 降级与容错（FR-011）

```bash
STORE=~/.claude/lossless/<project>/<session>
chmod 500 "$STORE"        # 制造不可写
# 继续对话
```

期望：对话正常继续；`/lossless status` 显示 `store: unavailable (EACCES)`；终端出现一次明确告警；原始消息不被静默丢弃（恢复权限后新消息可继续落盘）。

损坏行容错：

```bash
echo '{"broken": ' >> "$STORE/messages.jsonl"
/lossless doctor
```

期望：`doctor` 报告 `0 corrupt lines` 之前出现 `1 corrupt line` 计数，且不修改文件；随后正常对话不受影响。

## 8. 批次验收（FR-016 / SC-009）

每个 PR 结束时执行：

```bash
bun run typecheck
bun test src/services/lossless packages/builtin-tools/src/tools/LosslessTool
# 若本批次触及 feature()：
bun build --target=bun --production src/main.tsx --outdir /tmp/lossless-build
git --no-pager diff --stat    # 新增行数 ≤500
```

阻断条件：类型错误、测试失败、新增行数 >500、关闭态产生文件或请求、`feature()` 未通过真实构建验证。
