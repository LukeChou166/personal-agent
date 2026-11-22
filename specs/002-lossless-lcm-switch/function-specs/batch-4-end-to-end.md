# 批次 4–10 函数说明：分层摘要、装配、检索工具与护栏

**对应代码**：`src/services/lossless/*`、`src/commands/lossless/*`、`packages/builtin-tools/src/tools/LosslessTool/*`、`src/tools.ts`、`src/services/compact/{autoCompact,compact}.ts`
**说明**：用户要求一次性交付，原本的批次 4–10 合并为一个 PR，故函数说明合并为一份。

---

## 1. `createSummarizer({ model, timeoutMs })`

**职责**：把一段原文压成目标长度内的摘要，失败返回 `null`。

**输入示例**：`{ text: "user: 报错 FATAL: lock timeout…", targetTokens: 2400 }`

**输出示例**：`"用户遇到 lock timeout；定位到 src/db/conn.ts:88；尚未修复。"`

**为什么**：走 `sideQuery` 复用当前 provider 与鉴权，避免第二套密钥体系；超时用 `AbortController`，因为部分 provider 不响应取消也能靠 reject 兜底。

**输入 → 输出**：原文 → 系统提示（保留事实/路径/错误原文）→ `sideQuery`（`querySource: lossless_summary`，`max_tokens = targetTokens`）→ 取 text 块拼接 trim → 空结果或异常返回 `null`，交给引擎计失败。

---

## 2. `recordText(record)` / `planChunks(records, config)`

**职责**：前者把记录内容拍平成纯文本；后者按 token 预算与最小扇出切块。

**输入示例**：`[{seq:1,tokenEstimate:5,blocks:[text]} × 5]`，`leafChunkTokens=10, leafMinFanout=2`

**输出示例**：`[[1,2],[3,4]]`，第 5 条留待下轮；文本为 `"第 1 条消息内容"`。

**为什么**：摘要输入必须是纯文本（模型不读内部结构）；分块同时受 token 与条数约束，避免「1 条超长消息单独成块」或「10 条短消息合成碎块」。

**输入 → 输出**：累加 `tokenEstimate` → 达到预算且条数达扇出即切块 → 不够预算/条数的尾部不输出（成为待压缩）。

---

## 3. `makeNode(input)`

**职责**：构造一条摘要节点记录（id、层级、覆盖范围、正文、模型、状态）。

**输入示例**：`{ depth: 1, kind: 'leaf', span: { firstSeq: 1, lastSeq: 2 }, text: '摘要', model: 'claude-sonnet-4-5', messageIds: ['uuid-1','uuid-2'] }`

**输出示例**：`{ id: "n_9f2c1a0b3d4e", v: 1, tokenEstimate: 1, status: "active", createdAt: "2026-11-22T…" }`

**为什么**：id 随机生成而非自增，避免多进程/分支会话冲突；`tokenEstimate` 用 `length/4` 粗估，只用于预算，不追求精确。

**输入 → 输出**：入参 → 补 `v/id/tokenEstimate/createdAt/status` → 纯对象（由调用方追加到 `nodes.jsonl`）。

---

## 4. `createEngine({ store, config, summarize, model, session }).run()`

**职责**：一次压缩过程：生成叶子 → 浓缩 → 更新待压缩状态。

**输入示例**：`store` 中已有 8 条消息（每条 5 token），`freshTailCount=0, leafChunkTokens=10, leafMinFanout=2, condensedMinFanout=2, incrementalMaxDepth=1`

**输出示例**：`{ leavesCreated: 4, condensedCreated: 2, pendingMessages: 0, failures: 0, tripped: false }`

**为什么**：把「读—算—写」放在一次 `run()` 内，调用方不需要知道 DAG 细节；`tripped` 一旦为真，后续 `run()` 直接返回，防止失败会话持续烧钱。

**输入 → 输出**：
1. 读消息/节点/meta；`backlog.tripped` 为真则直接返回。
2. `coveredThrough = max(节点 span.lastSeq)`，候选 = 去掉新鲜尾巴、且 `seq > coveredThrough` 的消息。
3. 切块 → 逐块调摘要 → 成功则追加叶子节点；失败累计，达到 3 次停止。
4. 从 depth=1 起，把「未被父节点覆盖」的同层节点按 `condensedMinFanout` 分组浓缩；`incrementalMaxDepth` 限制层数。
5. 重算 `pendingMessages`（未被任何节点覆盖）与 `pendingNodes`（未被父节点覆盖），写回 meta（含熔断标记），返回计数。

**失败路径**：摘要返回 `null` 计一次失败；`failures ≥ 3` 写 `tripped: true`；异常被 `callSummary` 吞掉等价于失败。

---

## 5. `buildLosslessCompaction({ messages, nodes, freshTailCount, trigger, preCompactTokenCount })`

**职责**：把根摘要 + 新鲜尾巴装进既有 `CompactionResult` 契约。

**输入示例**：3 个节点（两个叶子被一个根覆盖），4 条消息，`freshTailCount=2, trigger='auto'`

**输出示例**：`{ boundaryMarker: <system>, summaryMessages: [<user isCompactSummary>], messagesToKeep: [m3, m4], attachments: [], hookResults: [] }`

**为什么**：不改 REPL 渲染与后续 API 归一化——沿用 `createCompactBoundaryMessage` 与 `createUserMessage`，下游只看到「一次正常压缩」。

**输入 → 输出**：找出无父节点的根 → 拼接正文（超过 32k 字符保留最近部分）→ 生成单条 summary 消息 → 尾部取最近 N 条原文 → 组装成 `CompactionResult`。无根节点时不生成 summary 消息，只保留尾巴。

---

## 6. `evaluateGuard` / `recordGuardCall` / `recordGuardFailure`

**职责**：判断能否发起摘要调用，并维护窗口计数与冷却。

**输入示例**：`state={windowStart:0,callsInWindow:2}, config={windowMs:1000,maxCallsPerWindow:2,backoffMs:5000}, now=500`

**输出示例**：`{ allowed: false, reason: 'window' }`；冷却期内 `{ allowed: false, reason: 'backoff' }`。

**为什么**：纯函数、状态外置，便于 `/lossless status` 直接读，也便于单测固定时间。

**输入 → 输出**：先判冷却（`now < backoffUntil`）→ 再判窗口是否过期并比较计数 → 允许则调用方 `recordGuardCall`（过期重置窗口）→ 失败则 `recordGuardFailure`（写入 `now + backoffMs`）。

---

## 7. `grepHistory` / `describeNode` / `expandNode`

**职责**：检索、查看节点、展开原文，全部限定当前会话。

**输入示例**：`grepHistory(store, { pattern: 'NEEDLE', limit: 20 })`；`expandNode(store, { nodeId: 'n1', maxTokens: 4000 })`

**输出示例**：`{ hits: [{ seq: 2, role: 'assistant', snippet: '…needle…', nodeId: 'n1' }], scanned: 4 }`；展开 `{ text: '[1/uuid-1/user]\n…', messages: 3, tokens: 15, truncated: false }`

**为什么**：只读、无模型调用，模型可以放心多次调用；`nodeId` 让模型知道「这段被哪层摘要覆盖」，从而决定是否值得展开。

**输入 → 输出**：grep 逐条拍平文本做大小写无关子串匹配，截取命中前后 120 字符，按 `limit` 截断并标注覆盖节点；describe 取节点 + 子节点 + 覆盖消息 token 和；expand 按 seq 排序，逐条累加 token，超预算时返回 `next.startSeq`。

---

## 8. `getSessionStore()`

**职责**：用设置 + 项目标识 + 会话标识构造存储句柄。

**输入**：无（读 `getLosslessConfig()`、`getOriginalCwd()`、`getSessionId()`）

**输出示例**：`{ store, config, session: { sessionId: '5f3a', projectKey: '-Users-z-proj' } }`

**为什么**：工具、状态命令、诊断、运行时都需要同一套路径解析；单独成文件避免它们被 `runtime` 的压缩依赖拖慢。

**输入 → 输出**：配置里的 `storeRoot` + `sanitizePath(cwd)` + `sessionId` → `createStore(...)` → 返回三元组。

---

## 9. `runLosslessCompaction(messages, context, trigger)`

**职责**：一次完整的无损压缩：跑引擎 → 合并护栏状态 → 装配结果。

**输入示例**：`messages`（当前上下文数组）、`trigger='auto' | 'manual'`、`context.options.mainLoopModel='claude-sonnet-4-5'`

**输出示例**：`CompactionResult`（boundary + 根摘要 + 新鲜尾巴）

**为什么**：把护栏状态放在闭包里、等引擎写完 backlog 后再合并落盘，避免「引擎写 meta」覆盖「摘要调用写的护栏」。

**输入 → 输出**：
1. `getSessionStore()` → 摘要模型取 `summaryModel ?? 主模型`。
2. 包装 `summarize`：先查护栏（拒绝则返回 null，不请求）→ 记一次调用 → 失败记冷却。
3. `engine.run()`（见 4）。
4. 把闭包里的 `guard` 合并进最新 meta。
5. 读节点 → `buildLosslessCompaction` → 返回。

---

## 10. `LcmGrepTool` / `LcmDescribeTool` / `LcmExpandTool`

**职责**：把检索能力暴露给模型。

**输入示例**：`{ pattern: "lock timeout", role: "assistant", limit: 10 }` / `{ node_id: "n_9f2c" }` / `{ node_id: "n_9f2c", max_tokens: 3000 }`

**输出示例**：JSON 字符串（`hits` / `node+children` / `text+messages+tokens+truncated`）

**为什么**：`isEnabled()` 动态返回 `isLosslessEnabled()`，使会话中途开启无需重启；全部 `isReadOnly`，不参与写权限询问。

**输入 → 输出**：zod 校验 → `getSessionStore()` → 调检索函数 → 映射为稳定 JSON → 异常收敛成 `{ error }` 不中断对话。

---

## 11. `diagnoseCurrentSession()` / `readCurrentStats()`

**职责**：只读状态与诊断。

**输入**：无。**输出示例**：`{ messages: 1832, nodes: 9, corruptLines: 0, badChildren: [], uncoveredMessages: 34 }`；统计快照含 `pendingMessages/pendingNodes/failures/tripped/callsInWindow/backoffUntil`。

**为什么**：只读 `meta.json` 计数，`status` 保持 200ms 内返回；`doctor` 只报告不修复，避免误删用户历史。

**输入 → 输出**：读 meta/节点/消息 → 计算计数、缺失子节点、未覆盖消息 → 返回纯对象；不写盘、不发模型请求。
