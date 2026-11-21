# 批次 2 函数说明：本地 JSONL 存储与状态接线

**对应代码**：`src/services/lossless/store.ts`、`src/services/lossless/stats.ts`、`src/services/lossless/index.ts`
**对应提交**：`ea53ef56`（PR #3）

---

## 1. `getStorePaths(storeRoot, projectKey, sessionId)`

**签名与职责**：把三个标识拼成会话目录下的三个固定文件路径，纯函数、不触盘。

**输入示例**

```json
{ "storeRoot": "/Users/z/.claude/lossless", "projectKey": "-Users-z-proj", "sessionId": "5f3a9c" }
```

**输出示例**

```json
{
  "dir": "/Users/z/.claude/lossless/-Users-z-proj/5f3a9c",
  "messages": "/Users/z/.claude/lossless/-Users-z-proj/5f3a9c/messages.jsonl",
  "nodes": "/Users/z/.claude/lossless/-Users-z-proj/5f3a9c/nodes.jsonl",
  "meta": "/Users/z/.claude/lossless/-Users-z-proj/5f3a9c/meta.json"
}
```

**为什么这样设计**：路径拼接只允许存在一处，否则测试用的临时根目录、真实用户目录、`LOSSLESS_DATABASE_PATH` 覆盖三套场景会各自手写 `join`，迟早漂移。纯函数也让测试不必准备真实用户目录。

**输入 → 处理 → 输出**：三个字符串直接 `join`，无校验、无副作用；`sessionId` 缺失属于调用方错误，由 `createStore` 的调用点保证，不在这一层兜底。

---

## 2. `parseLines<T>(content)`

**签名与职责**：把 JSONL 文本解析成对象数组，同时报告坏行数量。

**输入示例**

```text
{"v":1,"seq":1,"uuid":"a"}
{"broken":
{"v":1,"seq":2,"uuid":"b"}
```

**输出示例**

```json
{ "items": [{ "v": 1, "seq": 1, "uuid": "a" }, { "v": 1, "seq": 2, "uuid": "b" }], "corrupt": 1 }
```

**为什么这样设计**：进程崩溃或用户手工编辑都会留下半行。整文件 `JSON.parse` 遇到一行坏数据就全丢，与本特性「历史可还原」的承诺直接冲突；因此逐行解析并计数，坏行只影响自己。

**输入 → 处理 → 输出**：按 `\n` 切分 → 跳过空行 → 每行 `JSON.parse`，成功进 `items`，抛错累加 `corrupt` → 返回两者。坏行不尝试修复（修复属于 Out of Scope），只在 `doctor` 中报告。

---

## 3. `readText(path)`

**签名与职责**：读文件文本，任何读取失败统一返回空串。

**输入示例**：`"/Users/z/.claude/lossless/-proj/5f3a9c/meta.json"`

**输出示例**：文件不存在时 `""`；存在时返回原始内容。

**为什么这样设计**：调用方（`readMeta`/`readMessages`）关心的是「有没有数据」，不关心 ENOENT、EACCES 还是 EISDIR。把异常收敛在一处，避免每个读取点都写 try/catch。

**输入 → 处理 → 输出**：`readFileSync(utf8)`，catch 任意异常返回 `""`。真实错误（如磁盘故障）在此被吞掉，因此另有 `ensure()` 写入失败向上抛出，避免「读不到」掩盖「写不进」。

---

## 4. `createStore({ storeRoot, projectKey, sessionId })`

**签名与职责**：构造一个会话级存储句柄；所有落盘与读取都经由它，便于以后替换实现。

**输入示例**

```json
{ "storeRoot": "/tmp/lossless-test", "projectKey": "project", "sessionId": "session-1" }
```

**输出示例**：一个带 `paths` 与 8 个方法的对象（见下）。

**为什么这样设计**：把「路径 + 读写策略」封在一个闭包里，而不是散落的模块级函数。这样测试可并发创建多个互相隔离的 store，也不依赖全局单例；同时 `knownUuids` / `nextSeq` 这类派生读取可以复用同一份路径解析。

**输入 → 处理 → 输出**：先算 `paths`；调用 `ensure()` 时创建目录（`0700`）与两个空文件（`0600`），并用 `chmod` 收紧（失败忽略，兼容 Windows）；之后的每次追加都先 `ensure` 再 `appendFileSync`。

### 4.1 `ensure()`
- **输入**：无（使用构造时的 `paths`）。
- **输出**：目录与 `messages.jsonl` / `nodes.jsonl` 就绪；已存在时不做破坏性操作。
- **为什么**：允许「先读后写」，也允许会话中途开启；幂等是关键。
- **链路**：`mkdir -p` → 缺失文件用 `writeFileSync('', {mode:0o600})` 创建 → `chmod` 收紧 → 失败忽略。

### 4.2 `appendMessage(record)` / `appendNode(node)`
- **输入示例**：`{ "v":1,"seq":7,"uuid":"a3f","ts":"2026-11-21T09:00:00Z","role":"user","blocks":[{"type":"text","text":"hi"}],"tokenEstimate":3,"large":false }`
- **输出**：无返回值；文件末尾多一行 JSON。
- **为什么**：只支持追加，不支持改写。原文一旦写入就不可变，崩溃最多丢最后一行，不会出现「半更新」的历史。
- **链路**：`ensure()` → `JSON.stringify`（单行，转义内部换行）→ `appendFileSync(file, line + '\n')`。

### 4.3 `readMessages()` / `readNodes()`
- **输入**：无。
- **输出示例**：`{ "records": [...], "corruptLines": 1 }`。
- **为什么**：读取永远不抛错，保证「历史损坏」不会让对话失败；`corruptLines` 让状态命令能暴露问题。
- **链路**：`readText` → `parseLines` → 归一化字段为 `{records, corruptLines}` / `{nodes, corruptLines}`。

### 4.4 `readMeta()` / `writeMeta(meta)`
- **输入示例**：`{ "schemaVersion":1,"lastSeq":7,"messageCount":7,"nodeCount":0,... }`
- **输出**：`readMeta` 返回对象或 `null`；`writeMeta` 无返回值。
- **为什么**：`meta` 是「当前进度」的唯一快照，必须原子替换；否则崩溃时可能读到半个 JSON，导致序号回退、重复写入。
- **链路**：写入先落 `meta.json.tmp`（`0600`），再 `rename` 覆盖正式文件；读取遇空或解析失败返回 `null`，由调用方决定重建。

### 4.5 `knownUuids()`
- **输入**：无。
- **输出示例**：`Set { "a", "b", "c" }`。
- **为什么**：捕获去重需要「已存过哪些消息」。用 Set 而非数组，是为了每轮 `has()` 为 O(1)；只在捕获器首次运行时读一次盘。
- **链路**：`readMessages()` → 取 `uuid` 建 `Set`。重复 uuid 会被自然折叠。

### 4.6 `nextSeq()`
- **输入**：无。
- **输出示例**：`meta.lastSeq = 7` 时返回 `8`。
- **为什么**：序号必须跨重启单调；从 `meta` 推而不是从文件行数推，避免坏行导致序号冲突。
- **链路**：`readMeta()?.lastSeq ?? 0` → `+1`。

---

## 5. `readCurrentStats()`

**签名与职责**：给出 `/lossless status` 需要的计数快照。

**输入示例**：无显式入参；读取当前进程的运行环境——`getLosslessConfig()`、`getOriginalCwd()`、`getSessionId()`。

**输出示例**

```json
{ "recordsAvailable": true, "messages": 1832, "nodes": 9, "pendingMessages": 0, "failures": 0, "callsInWindow": 0 }
```

**为什么这样设计**：`status` 有 200ms 预算，不能扫 10k 条消息正文。只读 `meta.json` 的计数即可；开关关闭时直接返回空，保证零 I/O。

**输入 → 处理 → 输出**：开关未启用 → 返回空快照；否则按当前会话构造 `createStore` → `readMeta()`；无 meta（从未写过）→ 返回空快照；有 meta → 把 `messageCount/nodeCount` 映射到输出，`pendingMessages/failures/callsInWindow` 暂为 0（护栏与债务在后续批次接上）。

---

## 6. `getLosslessStats()`（门面）

**签名与职责**：对外暴露统计，内部懒加载 `stats.ts`。

**输入**：无。**输出**：同 `readCurrentStats()`，异常时返回空快照。

**为什么这样设计**：`index.ts` 会被命令层与设置测试同时引入；静态引入 `stats.ts` 会把 `bootstrap/state` 的文件系统副作用带进测试。懒 `require` + try/catch 让「读不到统计」退化为「显示 0」，而不是让命令崩溃。

**输入 → 处理 → 输出**：`require('./stats.js')` → `readCurrentStats()` → 原样返回；任意抛错 → 返回全零快照。
