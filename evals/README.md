# gwy-jobs-match evals — 从零跑通指南

用 [Harbor](https://harborframework.com/) 框架评测本项目（reverse-engineered 的
claude-code CLI）的 benchmark。结构与 Stanford CS329Z 的 assignment2-evals 对齐，
核心是把参考项目里的 `pinned_agent:MiniSweAgent` 换成自定义 agent
`claude_code_agent:ClaudeCodeSelfHostAgent`，让 Harbor 在任务容器内运行**本项目**
的 claude-code，而不是官方 Claude Code。

本指南假设你从一份全新的 claude-code 仓库开始，按步骤操作即可跑通评测 + langfuse
trace 观测。下文 `<repo>` 指 claude-code 仓库根目录（本目录 `evals/` 的上一级）。

## 目录结构

```text
evals/
├── pyproject.toml            # harbor 依赖（uv 管理）
├── claude_code_agent.py      # 自定义 agent：装 Bun + 上传本项目 + headless 调用
└── tasks/
    └── beijing-job-match/    # 示例任务：公务员岗位匹配查询（联网检索）
        ├── task.toml
        ├── instruction.md
        ├── environment/Dockerfile   # oven/bun + python3
        ├── solution/solve.sh        # oracle：写入标准答案 45 个 job_id（仅验证 verifier）
        └── tests/
            ├── test.sh              # verifier：写 /logs/verifier/reward.txt
            └── test_outputs.py      # 校验 CSV 的 job_id 与期望 45 个完全匹配
```

## 示例任务说明

`beijing-job-match`：给定考生条件（出生日期 1995-09-23、北京户口、硕士专业代码
085405、6 年基层经验、男性、硕士、本科计算机），让 claude-code **联网检索**（使用
WebSearch / WebFetch 工具）可报考的北京公务员岗位，输出 CSV `beijing_YYYYMMDD.csv`。
verifier 校验 CSV 中 `job_id` 是否与期望的 **45 个** 完全匹配（不多不少、无重复）。

> 该任务的数据源是「agent 自行联网检索」，不预置任何职位数据文件。

## 前置条件

| 工具 | 用途 | 检查命令 |
|------|------|----------|
| [uv](https://docs.astral.sh/uv/) | 安装 Harbor | `uv --version` |
| Docker（Desktop for Mac / OrbStack） | 评测沙箱 | `docker --version` |
| Bun | 构建本项目产物 | `bun --version` |
| 模型 API key | 跑 claude-code | Anthropic 或 OpenAI 兼容层任选其一 |
| 联网搜索工具 | 任务需联网检索 | claude-code 内置 WebSearch/WebFetch |
| 自建 langfuse（可选） | trace 观测 | 见下方「langfuse 观测」 |

## 操作步骤

### 第 1 步：构建本项目产物（产物模式需要）

在 `<repo>` 根目录构建，产出 `dist/cli.js` + chunk 文件（容器内无需再 `bun install`）：

```bash
cd <repo>
bun install
bun run build
```

> 也可跳过本步、改用「源码模式」（容器内 `bun install`，较慢且需联网编译 native
> 依赖），见第 5 步方式 B。

### 第 2 步：安装 evals 依赖

```bash
cd <repo>/evals
uv sync
uv run harbor --version   # 确认 harbor 可用
```

### 第 3 步：配置 settings（模型 + API key + langfuse）

agent 会自动把宿主机 `~/.claude/settings.json` 透传进容器（也可用
`--ak settings_path=/path/to/settings.json` 指定别的文件）。模型、API key、langfuse
都可以只配在 settings 里，命令行无需再传。

按你用的模型 provider 二选一（langfuse 的 `env` 是通用的，跟 provider 无关）：

**Anthropic 直连**：

```json
{
  "model": "claude-sonnet-4-5",
  "env": {
    "ANTHROPIC_API_KEY": "sk-ant-...",
    "LANGFUSE_PUBLIC_KEY": "pk-lf-...",
    "LANGFUSE_SECRET_KEY": "sk-lf-...",
    "LANGFUSE_BASE_URL": "http://localhost:3000"
  }
}
```

**OpenAI 兼容层**（已验证可用）：

```json
{
  "modelType": "openai",
  "env": {
    "CLAUDE_CODE_USE_OPENAI": "1",
    "OPENAI_API_KEY": "sk-...",
    "OPENAI_BASE_URL": "https://your-endpoint/v1",
    "OPENAI_MODEL": "qwen3.7-max",
    "LANGFUSE_PUBLIC_KEY": "pk-lf-...",
    "LANGFUSE_SECRET_KEY": "sk-lf-...",
    "LANGFUSE_BASE_URL": "http://localhost:3000"
  }
}
```

要点：
- `model` / `apiKey` / `LANGFUSE_*` 必须放在 **`env` 字段**里（settings 的 `env`
  字段会被 claude-code 启动时注入 `process.env`，顶层字段不会）。
- 若 `LANGFUSE_BASE_URL` 写的是 `localhost:3000`，agent 透传时会自动把
  `localhost` / `127.0.0.1` 替换成 `host.docker.internal`（容器内 localhost 指向
  容器自身，连不到宿主机）。**前提是宿主机 langfuse 监听 `0.0.0.0`**，见下方。

### 第 4 步：oracle 自检（验证 verifier 逻辑正确）

oracle 直接写入含 45 个标准答案 job_id 的 CSV，用于验证 verifier 逻辑正确（注意：
它**不验证** agent 的联网检索能力，因为检索结果是开放、非确定的）：

```bash
cd <repo>/evals
uv run harbor run -p ./tasks/beijing-job-match -a oracle --job-name beijing-job-match-oracle
```

`reward` 应为 `1`。

### 第 5 步：正式评测本项目 claude-code

**方式 A：产物模式（推荐，快）**——上传第 1 步构建的 `dist/`：

```bash
cd <repo>/evals
uv run harbor run -p ./tasks/beijing-job-match \
  -a claude_code_agent:ClaudeCodeSelfHostAgent \
  --ak dist_dir=<repo>/dist \
  --job-name beijing-job-match
```

**方式 B：源码模式**——直接上传源码并在容器内 `bun install`（较慢，需容器联网编译）：

```bash
cd <repo>/evals
uv run harbor run -p ./tasks/beijing-job-match \
  -a claude_code_agent:ClaudeCodeSelfHostAgent \
  --ak source_dir=<repo> \
  --job-name beijing-job-match
```

模型默认来自 settings（可省略 `-m`）。临时换模型才加 `-m <模型名>`（优先级高于
settings）。

参数说明：

| 参数 | 含义 |
|------|------|
| `-p/--path` | 本地任务目录 |
| `-a/--agent` | agent 名称，或自定义 agent 的 `module:Class` 路径 |
| `-m/--model` | 模型（可省略，省略时用 settings 里的 model） |
| `--ak/--agent-kwarg` | 传给 agent 构造器：`dist_dir=` / `source_dir=` / `settings_path=` |
| `--ae/--agent-env` | 透传环境变量，如 `--ae LANGFUSE_BASE_URL=...` |
| `--job-name` | job 目录名（不传则用时间戳） |
| `-n/--n-concurrent`、`-k/--n-attempts` | 并发数 / 每任务尝试次数 |

### 第 6 步：查看结果

```bash
cd <repo>/evals
uv run harbor view ./jobs/beijing-job-match
```

每个 trial 下会产出：

- `agent/claude-code.txt` — 本项目 CLI 的完整原始输出
- `agent/trajectory.json` — ATIF 轨迹（复用 Harbor 内置 claude-code 适配器的
  session jsonl → ATIF 转换，`harbor view` 据此可视化每一步）
- `verifier/reward.txt` — 0/1

## langfuse 观测（含完整排查）

本项目 claude-code 内置 langfuse（`src/services/langfuse/`），启用条件是
`LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` 同时存在（缺一则 no-op）。配在
settings 的 `env` 字段即可，agent 会透传进容器（见第 3 步）。

### 为什么 trace 可能看不到：`localhost` 在容器里失效

claude-code 跑在 Docker 容器内，容器里的 `localhost:3000` 指向**容器自身**，不是你
的宿主机。所以 settings 里写 `http://localhost:3000` 时，agent 透传会自动替换为
`http://host.docker.internal:3000`（Docker Desktop for Mac / OrbStack 的宿主机别名）。

要让 langfuse trace 正常上报，需满足两个条件：

1. **宿主机 langfuse 监听 `0.0.0.0:3000`**（而不是只 `127.0.0.1:3000`）：
   - 用 `docker run` 起的 langfuse：确保端口映射 `-p 3000:3000`（默认即绑定所有网卡）。
   - 用 `npx langfuse` 或本地进程起的：确认它监听 `0.0.0.0`。
2. **Docker 运行时支持 `host.docker.internal`**（Docker Desktop / OrbStack 都支持；
   Colima 需要额外 `--add-host host.docker.internal:host-gateway`）。

### 验证容器能否连通宿主机 langfuse

跑一条独立容器，模拟评测容器去访问宿主机 3000 端口：

```bash
docker run --rm alpine sh -c "wget -qO- http://host.docker.internal:3000/api/public/health || echo UNREACHABLE"
```

- 返回 JSON（health 状态）→ 连通正常，重跑评测即可在 langfuse 看到 trace。
- 返回 `UNREACHABLE` → 检查第 1 点（langfuse 是否监听 `0.0.0.0`）。

### 验证 langfuse 监听地址（宿主机）

```bash
# 看到 0.0.0.0:3000 或 :::3000 才算监听所有网卡；只有 127.0.0.1:3000 则容器连不到
lsof -iTCP:3000 -sTCP:LISTEN -n -P
```

### 命令行覆盖 baseUrl（可选）

不想改 settings 时，也可用 `--ae` 显式覆盖（注意：settings 的 `env` 在 claude-code
进程内 `Object.assign(process.env, ...)`，优先级高于 `--ae`，所以 settings 里若已写
`localhost` 会覆盖 `--ae`；要么改 settings，要么依赖 agent 的自动替换）：

```bash
uv run harbor run -p ./tasks/beijing-job-match \
  -a claude_code_agent:ClaudeCodeSelfHostAgent \
  --ak dist_dir=<repo>/dist \
  --ae LANGFUSE_BASE_URL=http://host.docker.internal:3000
```

claude-code 退出时会 flush 缓存的 span（`registerCleanup(shutdownLangfuse)`）。

## 常见问题（FAQ）

**Q：`reward.txt` 是 0 或 agent 报错？**
先跑第 4 步 oracle 自检确认 verifier 正常。oracle 通过但 agent 失败，通常是模型/
网络/权限/检索问题：看 `agent/claude-code.txt` 里的报错，确认 API key、
`--dangerously-skip-permissions`、模型名、以及联网检索是否可用。

**Q：verifier 报「未找到输出 CSV」？**
verifier 默认读 `/app/beijing_<当天日期>.csv`（fallback 会找 `beijing_*.csv` 最新）。
确认 agent 把 CSV 写到了 `/app/` 下，且文件名以 `beijing_` 开头、日期为容器当天。

**Q：容器里 `bun install` 失败 / 很慢（源码模式）？**
改用产物模式（第 1 步 `bun run build` + 第 5 步方式 A），避免在容器内编译 native 依赖。

**Q：`agent/trajectory.json` 缺失？**
轨迹转换依赖本项目 session jsonl 与官方 Claude Code 字段一致（本项目为
reverse-engineered，已按兼容处理）。若仍缺失，最坏情况只是看不到轨迹可视化，不影响
verifier 打分。

**Q：langfuse 里没看到新 trace？**
按「langfuse 观测」排查：先跑 `host.docker.internal` 连通性命令，再确认宿主机
langfuse 监听 `0.0.0.0`。

## 扩展新任务

复制 `tasks/beijing-job-match/`，改 `task.toml` 的 `name`、`instruction.md`、
`environment/`、`tests/test_outputs.py`（期望值）与 `solution/solve.sh` 即可。评测
多个任务时可把它们放进同一目录并指向 `-p ./tasks`（Harbor 会把每个子目录当作一个
task）。
