# 批次 3 函数说明：post-sampling 捕获钩子

**对应代码**：`src/services/lossless/capture.ts`、`src/setup.ts`（注册）
**状态**：本地已实现并通过测试，待批次 2 合并后提交

---

## 1. `matchesSessionPattern(pattern, key)`

**签名与职责**：把上游的会话 glob 语义翻译成正则匹配。

**输入示例**

```text
("agent:*",  "agent:main")       → true
("agent:*",  "agent:main:sub")   → false
("agent:**", "agent:main:sub")   → true
("session-1","session-1")        → true
```

**为什么这样设计**：直接复用上游的 `*`（不跨冒号）/ `**`（跨冒号）约定，用户从 lossless-claw 迁移过来时排除规则不用改写。用「先正则转义、再按 `**` 拆分、最后展开单 `*`」的顺序，避免引入控制字符占位（Biome 会拒绝控制字符正则）。

**输入 → 处理 → 输出**：转义正则元字符 → `split('**')` → 每段把 `*` 换成 `[^:]*` → 用 `.*` 连接 → 加 `^...$` 锚定 → `test(key)`。纯函数，无缓存；pattern 数量是个位数，不需要预编译。

---

## 2. `toBlocks(message)`

**签名与职责**：把内存消息的 `content` 归一化成统一的内容块数组。

**输入示例**

```json
{ "type": "user", "uuid": "a1", "message": { "content": "hello" } }
{ "type": "assistant", "uuid": "a2", "message": { "content": [{ "type": "text", "text": "hi" }] } }
```

**输出示例**

```json
[{ "type": "text", "text": "hello" }]
[{ "type": "text", "text": "hi" }]
```

**为什么这样设计**：`content` 有三种形态（字符串 / 块数组 / 缺失）。如果每条下游逻辑各自判断，存储记录会长出三种形状，检索与回放都要分叉。统一成数组后，`blocks` 是唯一形状。

**输入 → 处理 → 输出**：字符串 → 包成单个 text 块；数组 → 原样保留（仅类型断言）；其他（缺失/异常）→ 空数组，保证记录仍可写入。

---

## 3. `findToolRef(blocks)`

**签名与职责**：从内容块里找出工具调用/结果关联的 id 与工具名。

**输入示例**

```json
[{ "type": "tool_use", "id": "tu_1", "name": "Read", "input": {} }]
[{ "type": "tool_result", "tool_use_id": "tu_1", "content": "..." }]
```

**输出示例**：`{ "id": "tu_1", "name": "Read" }`；`{ "id": "tu_1" }`（结果块没有工具名）；无工具块时 `{}`。

**为什么这样设计**：记录里冗余保存 `toolUseId` / `toolName`，是为了后续「按工具检索」与「把调用和结果配对」时不必再解析全部块；同时保持两个字段可选，普通文本消息不产生噪声。

**输入 → 处理 → 输出**：顺序扫描块 → 遇到第一个 `tool_use` 返回 `{id, name}`；遇到 `tool_result` 返回 `{id}`；都没遇到返回 `{}`。只取第一个，因为一条记录通常只承载一次工具交互。

---

## 4. `buildRecord(message, seq, config)`

**签名与职责**：把一条内存消息转成可追加的记录行。

**输入示例**

```json
{ "message": { "type": "user", "uuid": "a1", "message": { "content": "hi" } }, "seq": 7, "config": { "largeFileTokenThreshold": 25000 } }
```

**输出示例**

```json
{
  "v": 1, "seq": 7, "uuid": "a1", "ts": "2026-11-21T09:12:33.000Z",
  "role": "user", "blocks": [{ "type": "text", "text": "hi" }],
  "tokenEstimate": 3, "large": false
}
```

**为什么这样设计**：记录必须自包含——只靠这一行就能定位（`seq`/`uuid`）、排序（`seq`）、展示（`role`/`blocks`）与判断是否需要隔离（`large`）。`tokenEstimate` 用 `JSON.stringify(blocks).length / 4` 的粗估，而不是精确 tokenizer：它只用于大块阈值判断，精确值会带来每条消息一次的编码成本。

**输入 → 处理 → 输出**：`toBlocks` 归一化 → 序列化长度 ÷ 4 得估算值 → 与 `largeFileTokenThreshold` 比较得 `large` → `findToolRef` 补 `toolUseId`/`toolName` → 加上版本号、序号、时间戳、角色 → 返回记录对象。`ts` 取写入时刻而非原始消息时间，用于「何时被记录」。

---

## 5. `createCapture(store, config, session)`

**签名与职责**：为一个会话创建捕获器；调用一次处理一轮消息，返回本轮新增条数。

**输入示例**

```json
{
  "messages": [
    { "type": "user", "uuid": "a", "message": { "content": "one" } },
    { "type": "assistant", "uuid": "b", "message": { "content": "two" } }
  ]
}
```

**输出示例**：`2`（首次调用）；下一轮传入 `[b, c]` 时返回 `1`（`b` 已存在，只写 `c`）。

**为什么这样设计**：捕获状态（已见 uuid、下一个序号、meta 快照）放闭包里，而不是每轮读盘：`seen` 只需首次构建，之后每轮都是 O(1) 判断；`meta` 在内存累积，每轮结束原子落盘一次，避免每条消息都重写 meta。排除模式放在最前面判断，命中就零 I/O 返回。

**输入 → 处理 → 输出**：
1. 命中 `ignoreSessionPatterns` → 返回 `0`（完全不记录）。
2. 命中 `statelessSessionPatterns` → 返回 `0`（只读不写）。
3. 首次调用 `init()`：读全部消息构建 `seen`、从 `meta.lastSeq` 与最大 `seq` 取较大值算 `nextSeq`、补齐缺失的 meta。
4. 逐条遍历：`uuid` 在 `seen` 中跳过；否则 `buildRecord` → `appendMessage` → 加入 `seen` → 序号 +1。
5. 有新增时更新 `messageCount` / `lastSeq` / `updatedAt`，`writeMeta` 一次。
6. 返回新增条数（用于测试与后续统计）。

**失败路径**：写盘异常向上抛出，由注册层捕获并降级为「本轮未记录」，不阻断对话。

---

## 6. `registerLosslessCapture()`

**签名与职责**：在 setup 阶段注册 post-sampling 钩子；进程内只注册一次。

**输入**：无显式入参。**输出**：无返回值，副作用是向钩子注册表追加一个回调。

**为什么这样设计**：钩子必须「无条件注册、内部实时判断开关」，否则会话中途 `/lossless on` 无法立即生效；若在注册时就判断，则开启后必须重启进程。`capturer` 按 `sessionId` 缓存，是为了 `--resume` 或切换会话后仍指向正确目录，同时避免每轮重建。

**输入 → 处理 → 输出**：
1. 已注册则直接返回（幂等）。
2. 注册回调：首行 `isLosslessEnabled()`，关闭时立即返回（零 I/O，满足 FR-002）。
3. 读取配置 → 取 `sessionId` → 命中缓存则复用，否则用 `sanitizePath(getOriginalCwd())` 算 `projectKey`、`createStore`、`createCapture` 并缓存。
4. 调用捕获器处理 `context.messages`。
5. 任意异常：`logForDebugging` 记录后吞掉，绝不让捕获失败影响主对话。
