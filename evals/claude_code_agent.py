"""把本项目（reverse-engineered）claude-code CLI 接入 Harbor 的自定义 agent。

类比参考项目 assignment2-evals 的 ``pinned_agent.py``（子类化内置
``MiniSweAgent`` 只重写 ``install``），这里子类化 Harbor 内置的 ``ClaudeCode``，
只重写两处：
- ``install()``：装 Bun + 上传本项目源码/产物（而非 npm 安装官方 claude-code）
- ``run()``：用 ``bun`` headless 调用本项目 cli（而非官方 ``claude`` 命令）

轨迹转换（session jsonl -> ATIF ``trajectory.json``）复用内置 ``ClaudeCode`` 的
``populate_context_post_run()`` / ``_convert_events_to_trajectory()``，因此能产出
``agent/trajectory.json`` 供 ``harbor view`` 可视化。

使用方式（在 evals/ 目录下）：

    uv run harbor run -p ./tasks/claude-code-bugfix-0 \\
      -a claude_code_agent:ClaudeCodeSelfHostAgent \\
      --ak dist_dir=/abs/path/to/claude-code/dist

两种源码来源（二选一，通过 ``--ak`` 或环境变量传入）：
- ``dist_dir``：本项目 ``bun run build`` 产出的 ``dist/`` 目录（推荐，无需容器内
  安装依赖，上传快）。
- ``source_dir``：本项目源码根目录（容器内 ``bun install``，较慢且需联网编译）。
"""

from __future__ import annotations

import os
import shlex
from pathlib import Path

from harbor.agents.installed.base import with_prompt_template
from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

# 容器内本项目代码/产物的固定落点。
CLAUDE_CODE_INSTALL_DIR = "/app/claude-code"
# 源码模式下相对仓库根的 CLI 入口。
SOURCE_ENTRYPOINT = "src/entrypoints/cli.tsx"
# 产物模式下相对安装目录的入口。
DIST_ENTRYPOINT = "dist/cli.js"
# 容器内 claude-code 配置目录。与内置 ClaudeCode 保持一致（/logs/agent/sessions），
# session jsonl 落点在此，内置的轨迹转换逻辑据此定位日志。
CLAUDE_CONFIG_DIR = (EnvironmentPaths.agent_dir / "sessions").as_posix()


class ClaudeCodeSelfHostAgent(ClaudeCode):
    """在任务容器内运行本项目 claude-code CLI 完成 instruction。"""

    SUPPORTS_ATIF: bool = True

    @staticmethod
    def name() -> str:
        return "claude-code-selfhost"

    def __init__(
        self,
        logs_dir: Path,
        source_dir: str | None = None,
        dist_dir: str | None = None,
        settings_path: str | None = None,
        *args,
        **kwargs,
    ):
        self._source_dir = source_dir or os.environ.get("CLAUDE_CODE_SOURCE_DIR")
        self._dist_dir = dist_dir or os.environ.get("CLAUDE_CODE_DIST_DIR")
        self._settings_path = self._resolve_settings_path(settings_path)
        self._entrypoint: str | None = None
        super().__init__(logs_dir, *args, **kwargs)

    @staticmethod
    def _resolve_settings_path(settings_path: str | None) -> Path | None:
        """定位宿主机 claude-code settings 文件，用于透传进容器。"""
        if settings_path:
            return Path(settings_path).expanduser().resolve()
        env_path = os.environ.get("CLAUDE_CODE_SETTINGS_PATH")
        if env_path:
            return Path(env_path).expanduser().resolve()
        default = Path.home() / ".claude" / "settings.json"
        return default if default.is_file() else None

    async def install(self, environment: BaseEnvironment) -> None:
        """安装 Bun（如镜像未自带）并把本项目代码/产物 + settings 上传进容器。"""
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

        # 透传 settings，使 settings.model / apiKey 等在容器内生效（可省略 -m）。
        # 容器内 localhost / 127.0.0.1 指向容器自身，替换为 host.docker.internal，
        # 让 langfuse 等跑在宿主机上的服务可被容器访问。
        if self._settings_path:
            await self.exec_as_root(
                environment,
                command=f"mkdir -p {CLAUDE_CONFIG_DIR}",
            )
            content = self._settings_path.read_text()
            content = content.replace("localhost", "host.docker.internal")
            content = content.replace("127.0.0.1", "host.docker.internal")
            await self.exec_as_agent(
                environment,
                command=(
                    f"cat > {CLAUDE_CONFIG_DIR}/settings.json <<'CLAUDE_SETTINGS_EOF'\n"
                    f"{content}\nCLAUDE_SETTINGS_EOF\n"
                ),
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
            # 指向 install 阶段已透传 settings.json 的配置目录（session jsonl 落点）。
            "CLAUDE_CONFIG_DIR": CLAUDE_CONFIG_DIR,
        }
        if self.model_name:
            # 官方 Claude Code 用 ANTHROPIC_MODEL，本项目兼容；优先级高于 settings.model。
            env["ANTHROPIC_MODEL"] = self.model_name.split("/")[-1]
        env = {k: v for k, v in env.items() if v}

        command = (
            f"mkdir -p {CLAUDE_CONFIG_DIR} && "
            f"cd {CLAUDE_CODE_INSTALL_DIR} && "
            f"printf '%s' {shlex.quote(instruction)} | "
            f"{self._entrypoint} --dangerously-skip-permissions -p "
            f"2>&1 | tee /logs/agent/claude-code.txt"
        )

        await self.exec_as_agent(environment, command=command, env=env)
