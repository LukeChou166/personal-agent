# Lossless context mode (lossless-claw adaptation)

## Reference implementation

- Upstream: `https://github.com/Martian-Engineering/lossless-claw`
- License: MIT (Martian Engineering)
- Baseline for behaviour/configuration semantics: the `latest` npm channel at the time of
  implementation. Pin the exact version or commit here when the reference is consulted:

```text
reference_version: TBD at implementation time (record semver or commit sha)
```

Nothing from upstream is copied as source. This module re-implements the user-visible
capabilities (full local retention, layered summaries, retrieval/expand, spend guards)
against this repository's own message pipeline. If a snippet is ever copied verbatim, keep
its original copyright header and record it below.

## Capability map

| Upstream concept | This implementation |
|---|---|
| `lcm.db` (SQLite) | Per-session append-only JSONL under `<configHome>/lossless/` |
| leaf / condensed summaries | `nodes.jsonl` with `depth`, `childNodeIds`, `span` |
| `lcm_grep` / `lcm_describe` / `lcm_expand` | `LcmGrep` / `LcmDescribe` / `LcmExpand` tools |
| `freshTailCount`, `contextThreshold`, `leafChunkTokens` | same names under `settings.lossless` |
| summary spend guards | `summaryMaxCallsPerWindow`, `summarySpendBackoffMs`, `summaryTimeoutMs` |

## Deliberate differences

- No plugin host: this is an in-process service, not an OpenClaw plugin.
- No SQLite / FTS5 dependency: storage must work on both Bun and Node builds.
- No backfill migration, repair, cleanup or TUI in v1 (see `specs/002-lossless-lcm-switch/spec.md`, Out of Scope).

## Status

已实现：设置解析、`/lossless` 命令、JSONL 存储、post-sampling 捕获、
分层摘要（叶子 + 浓缩）、上下文装配与自动/手动压缩接管、三个回溯工具、
花费护栏、只读状态与诊断。

未实现（见 spec 的 Out of Scope）：历史回填迁移、诊断修复/清理/备份、
跨设备同步、图形化浏览、跨会话摘要移植、多进程共享库。
