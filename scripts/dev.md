# scripts/dev.ts 说明（`bun run dev`）

> 问题：`bun run dev` 启动的端口是哪个？
> 结论：**不占用任何端口**——它是纯终端 CLI 进程，不是 HTTP 服务。

## 1. 脚本链路

```json
// package.json:48
"dev": "bun run scripts/dev.ts"
```

`scripts/dev.ts:47-58` 用 `Bun.spawnSync` 拉起 CLI：

```ts
const result = Bun.spawnSync(
  ['bun', ...inspectArgs, 'run', ...defineArgs, ...featureArgs, cliPath, ...process.argv.slice(2)],
  { stdio: ['inherit', 'inherit', 'inherit'], cwd: projectRoot },
)
```

- 入口：`src/entrypoints/cli.tsx`（由 `scripts/dev.ts:15` 拼出）
- `-d` 注入 `MACRO.*` defines（`scripts/dev.ts:17-28`，来源 `scripts/defines.ts` 的 `getMacroDefines()`），并强制 `process.env.NODE_ENV = "production"` 以避免 React dev 模式堆积 `_debugStack`
- `--feature` 逐个启用 feature flag（`scripts/dev.ts:39-40`）：`DEFAULT_BUILD_FEATURES` + 任一 `FEATURE_<NAME>=1` 环境变量
- `BUN_INSPECT` 存在时追加 `--inspect-wait=<port>`（`scripts/dev.ts:42-45`）——这是**调试器**端口（默认 9229），不是业务端口，且只在 `bun run dev:inspect`（`scripts/dev-debug.ts`）场景下常用

因此 `bun run dev` 全程是「终端 stdin/stdout + Ink 渲染」，**没有 listen、没有 HTTP server**。

## 2. 哪些脚本才真有端口

| 命令 | 端口 | 来源 | 说明 |
|---|---|---|---|
| `bun run dev` | 无 | `scripts/dev.ts` | 交互式 CLI/REPL |
| `bun run rcs` | **3000**（`RCS_PORT` 可覆盖） | `scripts/rcs.ts:14-16` → `packages/remote-control-server/src/config.ts:3-4` | Remote Control Server；默认监听 `0.0.0.0:3000`，`Bun.serve(server.default)` |
| `bun run docs:dev` | **3000**（Mintlify CLI 默认，可 `--port`） | `package.json:66` | Mintlify 文档预览 |

`packages/remote-control-server/src/config.ts:1-5`：

```ts
export const config = {
  version: process.env.RCS_VERSION || '0.1.0',
  port: parseInt(process.env.RCS_PORT || '3000', 10),
  host: process.env.RCS_HOST || '0.0.0.0',
  apiKeys: (process.env.RCS_API_KEYS || '').split(',').filter(Boolean),
  …
}
```

`scripts/rcs.ts` 启动时会打印：

```
[RCS] Starting Remote Control Server...
[RCS] Port: 3000
[RCS] API Key configuration loaded
```

注意：`bun run rcs` 和 `bun run docs:dev` **默认端口都是 3000**，同时跑会冲突，需用 `RCS_PORT=4000 bun run rcs` 或 `npx mintlify dev --port 4001` 错开。

## 3. 其他相关 env

- `FEATURE_<NAME>=1` —— 额外启用 feature flag（`scripts/dev.ts:35-38`），与端口无关
- `BUN_INSPECT=9229` —— debugger 端口，走 `--inspect-wait`
- 真正的网络监听配置集中在 `packages/remote-control-server/src/config.ts`（`RCS_PORT` / `RCS_HOST` / `RCS_API_KEYS` / `RCS_BASE_URL`）

## 4. 一句话总结

`bun run dev` 不启动服务、不占端口；项目里唯一有业务端口的命令是 `bun run rcs`（默认 **3000**，`RCS_PORT` 可改），文档站 `bun run docs:dev` 也默认 3000。
