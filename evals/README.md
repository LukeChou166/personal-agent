# claude-code evals

用 [Harbor](https://harborframework.com/) 框架评测本项目（reverse-engineered 的
claude-code CLI）的 benchmark。结构与 Stanford CS329Z 的 assignment2-evals 对齐，
核心是把参考项目里的 `pinned_agent:MiniSweAgent` 换成自定义 agent
`claude_code_agent:ClaudeCodeSelfHostAgent`，让 Harbor 在任务容器内运行**本项目**
的 claude-code，而不是官方 Claude Code。

## 目录结构

```text
evals/
├── pyproject.toml            # harbor 依赖（uv 管理）
├── claude_code_agent.py      # 自定义 agent：装 Bun + 上传本项目 + headless 调用
└── tasks/
    └── claude-code-bugfix-0/ # 示例任务：修复一个 Python bug
        ├── task.toml
        ├── instruction.md
        ├── environment/Dockerfile   # oven/bun + python3
        ├── environment/buggy.py     # 含 bug 的代码
        ├── solution/solve.sh        # oracle 参考解法
        └── tests/
            ├── test.sh              # verifier：写 /logs/verifier/reward.txt
            └── test_outputs.py      # 断言
```

## 前置条件

1. 安装 [uv](https://docs.astral.sh/uv/) 和 Docker。
2. 准备模型与 API key（二选一）：

   - 直接用宿主机 settings：agent 会自动把 `~/.claude/settings.json` 透传进容器，
     其中的 `model` / `apiKey` 都会生效（见下方「模型配置」）。
   - 或用环境变量显式指定：

   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   # 若走 OpenAI 兼容层：export CLAUDE_CODE_USE_OPENAI=1 OPENAI_API_KEY=...
   ```

3. （推荐）先构建本项目产物，避免在容器内 `bun install`：

   ```bash
   cd /Users/zhouli/Documents/work_space/claude-code
   bun run build   # 产出 dist/cli.js + chunk
   ```

## 安装依赖

```bash
cd /Users/zhouli/Documents/work_space/claude-code/evals
uv sync
uv run harbor --version
```

## 第 1 步：oracle 自检（验证任务本身可解）

先用 Harbor 内置 `oracle` 跑 `solution/solve.sh`，确认任务与 verifier 正确，不经过 claude-code：

```bash
uv run harbor run -p ./tasks/claude-code-bugfix-0 -a oracle --job-name claude-code-bugfix-0-oracle
```

reward 应为 `1`。

## 第 2 步：正式评测本项目 claude-code

**方式 A：产物模式（推荐，快）**——先 `bun run build`，再上传 `dist/`：

```bash
uv run harbor run -p ./tasks/claude-code-bugfix-0 \
  -a claude_code_agent:ClaudeCodeSelfHostAgent \
  --ak dist_dir=/Users/zhouli/Documents/work_space/claude-code/dist \
  --job-name claude-code-bugfix-0
```

**方式 B：源码模式**——直接上传源码并在容器内 `bun install`（较慢，需容器能联网编译 native 依赖）：

```bash
uv run harbor run -p ./tasks/claude-code-bugfix-0 \
  -a claude_code_agent:ClaudeCodeSelfHostAgent \
  --ak source_dir=/Users/zhouli/Documents/work_space/claude-code \
  --job-name claude-code-bugfix-0
```

参数说明：

| 参数 | 含义 |
|------|------|
| `-p/--path` | 本地任务目录 |
| `-a/--agent` | agent 名称，或自定义 agent 的 `module:Class` 路径 |
| `-m/--model` | 模型（可省略，省略时用 settings 里的 model） |
| `--ak/--agent-kwarg` | 传给 agent 构造器，如 `dist_dir=` / `source_dir=` |
| `--ae/--agent-env` | 透传环境变量，如 `--ae CLAUDE_CODE_USE_OPENAI=1` |
| `--job-name` | job 目录名（不传则用时间戳） |
| `-n/--n-concurrent`、`-k/--n-attempts` | 并发数 / 每任务尝试次数 |

### 模型配置：`-m` 可省略

本项目 claude-code 的模型读取优先级是 `--model` > `ANTHROPIC_MODEL` > `settings.model` > 默认。

Harbor 里 claude-code 跑在 Docker 容器内，读不到宿主机 `~/.claude/settings.json`，因此：

- **省略 `-m`（用 settings）**：agent 会自动把宿主机 `~/.claude/settings.json`
  透传进容器（或 `--ak settings_path=/path/to/settings.json` 显式指定），容器内按
  `settings.model` 选模型：

  ```bash
  uv run harbor run -p ./tasks/claude-code-bugfix-0 \
    -a claude_code_agent:ClaudeCodeSelfHostAgent \
    --ak dist_dir=/Users/zhouli/Documents/work_space/claude-code/dist
  ```

- **显式 `-m`**：优先级高于 settings，会覆盖 settings 里的模型（格式如
  `anthropic/claude-sonnet-4-5`）：

  ```bash
  uv run harbor run -p ./tasks/claude-code-bugfix-0 \
    -a claude_code_agent:ClaudeCodeSelfHostAgent \
    -m <模型名> \
    --ak dist_dir=/Users/zhouli/Documents/work_space/claude-code/dist
  ```

## 查看结果

```bash
uv run harbor view ./jobs/claude-code-bugfix-0
```

每个 trial 下会产出 `agent/claude-code.txt`（本项目 CLI 的完整输出）与
`verifier/reward.txt`（0/1）。

## 扩展新任务

复制 `tasks/claude-code-bugfix-0/`，改 `task.toml` 的 `name`、`instruction.md`、
`environment/`、`tests/` 即可。评测多个任务时可把它们放进同一目录并指向
`-p ./tasks`（Harbor 会把每个子目录当作一个 task）。
