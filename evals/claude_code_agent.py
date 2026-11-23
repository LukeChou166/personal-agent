"""把本项目（reverse-engineered）claude-code CLI 接入 Harbor 的自定义 agent。

类比参考项目 assignment2-evals 里的 ``pinned_agent.py``：参考项目用
``class MiniSweAgent(_MiniSweAgent)`` 子类化内置 agent 来接入 mini-swe-agent，
这里则直接继承 ``BaseInstalledAgent``，把「安装/调用官方 claude-code」替换成
「安装 Bun + 上传本项目源码 + headless 调用本项目 claude-code」。

使用方式（在 evals/ 目录下）：

    uv run harbor run -p ./tasks/claude-code-bugfix-0 \\
      -a claude_code_agent:ClaudeCodeSelfHostAgent \\
      -m anthropic/claude-sonnet-4-5 \\
      --ak dist_dir=/abs/path/to/claude-code/dist \\
      --job-name claude-code-bugfix-0

两种源码来源（二选一，通过 ``--ak`` 或环境变量传入）：
- ``dist_dir``：本项目 ``bun run build`` 产出的 ``dist/`` 目录（推荐，无需在容器内
  安装依赖，上传快）。
- ``source_dir``：本项目源码根目录（会在容器内 ``bun install``，上传与安装都较慢，
  且需容器能联网编译 native 依赖）。
"""

from __future__ import annotations

import os
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

# 容器内本项目代码/产物的固定落点。
CLAUDE_CODE_INSTALL_DIR = "/app/claude-code"
# 源码模式下相对仓库根的 CLI 入口。
SOURCE_ENTRYPOINT = "src/entrypoints/cli.tsx"
# 产物模式下相对安装目录的入口。
DIST_ENTRYPOINT = "dist/cli.js"


class ClaudeCodeSelfHostAgent(BaseInstalledAgent):
    """在任务容器内运行本项目 claude-code CLI 完成 instruction。"""

    @staticmethod
    def name() -> str:
        return "claude-code-selfhost"

    def __init__(
        self,
        logs_dir: Path,
        source_dir: str | None = None,
        dist_dir: str | None = None,
        *args,
        **kwargs,
    ):
        self._source_dir = source_dir or os.environ.get("CLAUDE_CODE_SOURCE_DIR")
        self._dist_dir = dist_dir or os.environ.get("CLAUDE_CODE_DIST_DIR")
        self._entrypoint: str | None = None
        super().__init__(logs_dir, *args, **kwargs)

    async def install(self, environment: BaseEnvironment) -> None:
        """安装 Bun（如镜像未自带）并把本项目代码/产物上传进容器。"""
        # oven/bun 基础镜像已自带 bun；此处仅为 python 等基础镜像兜底。
        await self.exec_as_root(
            environment,
            command=(
                "command -v bun >/dev/null 2>&1 || { "
                "curl -fsSL https://bun.sh/install | bash; "
                'ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun; '
                "}"
            ),
        )

        if self._source_dir:
            src = Path(self._source_dir).expanduser().resolve()
            if not src.is_dir():
                raise RuntimeError(f"source_dir 不存在: {src}")
            await environment.upload_dir(
                source_dir=src,
                target_dir=CLAUDE_CODE_INSTALL_DIR,
            )
            await self.exec_as_agent(
                environment,
                command=f"cd {CLAUDE_CODE_INSTALL_DIR} && bun install",
            )
            self._entrypoint = f"bun run {SOURCE_ENTRYPOINT}"
        elif self._dist_dir:
            dist = Path(self._dist_dir).expanduser().resolve()
            if not dist.is_dir():
                raise RuntimeError(f"dist_dir 不存在: {dist}")
            await environment.upload_dir(
                source_dir=dist,
                target_dir=f"{CLAUDE_CODE_INSTALL_DIR}/dist",
            )
            self._entrypoint = f"bun {DIST_ENTRYPOINT}"
        else:
            raise RuntimeError(
                "必须通过 --ak source_dir=... 或 --ak dist_dir=... 指定本项目代码/产物路径"
            )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self._entrypoint:
            raise RuntimeError("agent 未初始化入口（install 未正确执行）")

        api_key = (
            self._get_env("ANTHROPIC_API_KEY")
            or self._get_env("ANTHROPIC_AUTH_TOKEN")
            or ""
        )
        env = {
            "ANTHROPIC_API_KEY": api_key,
            # 沙箱内允许 bypassPermissions；headless 下跳过信任/权限交互。
            "IS_SANDBOX": "1",
            # 关闭遥测等非必要流量。
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        }
        if self.model_name:
            # 官方 Claude Code 用 ANTHROPIC_MODEL，本项目兼容该变量。
            env["ANTHROPIC_MODEL"] = self.model_name.split("/")[-1]
        env = {k: v for k, v in env.items() if v}

        command = (
            f"cd {CLAUDE_CODE_INSTALL_DIR} && "
            f"printf '%s' {shlex.quote(instruction)} | "
            f"{self._entrypoint} --dangerously-skip-permissions -p "
            f"2>&1 | tee /logs/agent/claude-code.txt"
        )

        await self.exec_as_agent(environment, command=command, env=env)
