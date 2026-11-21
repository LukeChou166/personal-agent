# Contract: 回溯工具（模型可见）

**Feature**: `002-lossless-lcm-switch` | **Version**: 1

三个工具均实现 `Tool` 接口（`src/Tool.ts`），使用 `buildTool`（参考 `packages/builtin-tools/src/tools/SnipTool/SnipTool.ts:27`）。文件位于 `packages/builtin-tools/src/tools/LosslessTool/`。

**共同约束**:
- `isEnabled()` 返回 `isLosslessEnabled()`；关闭时不进入工具列表（FR-002）。
- `isReadOnly()` 返回 `true`，`isConcurrencySafe()` 返回 `true`。
- 所有查询强制带当前 `sessionId`；跨会话引用一律拒绝（FR-006）。
- 返回内容受 `maxResultSizeChars` 限制，超出时截断并标记 `truncated: true`。
- 不发起模型调用，纯本地读取。

---

## 1. `LcmGrep`

按关键词检索当前会话历史（含已被摘要覆盖的消息）。

```jsonc
// input
{
  "pattern": "FATAL: lock timeout",   // required，大小写无关子串
  "limit": 20,                        // 1..50，默认 20
  "role": "any",                      // "user" | "assistant" | "any"，默认 any
  "node_id": null                     // 可选：仅在该摘要节点覆盖范围内检索
}
```

```jsonc
// output
{
  "hits": [
    {
      "message_id": "018f...",
      "seq": 412,
      "ts": "2026-11-21T08:12:33Z",
      "role": "assistant",
      "snippet": "…FATAL: lock timeout after 30s…",
      "node_id": "n_7f3a",           // 若该消息已被摘要覆盖
      "large": false
    }
  ],
  "total_matched": 3,
  "scanned_messages": 1832,
  "truncated": false
}
```

**行为**:
- 只解析命中行；`scanned_messages` 用于让模型判断检索完备性。
- `node_id` 存在时提示模型可用 `LcmExpand` 取回原文。
- 无命中返回空数组，不报错。

---

## 2. `LcmDescribe`

查看一个摘要节点的覆盖范围、层级与正文。

```jsonc
// input
{ "node_id": "n_7f3a" }
```

```jsonc
// output
{
  "node": {
    "id": "n_7f3a",
    "depth": 2,
    "kind": "condensed",
    "span": { "first_seq": 120, "last_seq": 980 },
    "token_estimate": 1980,
    "model": "claude-sonnet-4-5",
    "created_at": "2026-11-21T07:40:02Z",
    "status": "active",
    "text": "…"
  },
  "children": [
    { "id": "n_1a2b", "depth": 1, "span": { "first_seq": 120, "last_seq": 540 } }
  ],
  "expandable_tokens": 18400
}
```

**行为**:
- `children` 最多返回 20 个，超出时提示用 `LcmGrep` 缩小范围。
- 节点 `corrupt` 时返回该节点元数据与 `status: "corrupt"`，不抛错。
- 节点不存在时返回 `{ "error": "node_not_found" }`。

---

## 3. `LcmExpand`

把摘要节点（或其覆盖的消息）还原为原文片段。

```jsonc
// input
{
  "node_id": "n_7f3a",       // 与 message_ids 二选一
  "message_ids": null,
  "max_tokens": 4000          // 可选，上限取设置 maxExpandTokens
}
```

```jsonc
// output
{
  "text": "…还原后的原文，按时间顺序拼接…",
  "messages": 12,
  "tokens": 3820,
  "truncated": true,
  "next": { "start_seq": 981 }   // 截断时的续读游标
}
```

**行为**:
- 按 `seq` 正序拼装；每条消息前缀 `[seq/uuid/role]` 便于引用。
- 超过 `max_tokens` 时截断并给出 `next.start_seq`，模型可继续展开。
- 只允许展开当前会话内的节点或消息（FR-006）。
- 大块工具结果（`large: true`）展开时以其落盘引用内容为准，遵守同一 token 上限。

---

## 4. 提示词要求（`prompt.ts`）

工具描述必须说明：

1. 何时使用（模型需要精确原文而非摘要时）。
2. 检索优先、展开其次（先 `LcmGrep` 定位，再 `LcmExpand` 取原文）。
3. 展开会消耗上下文，按需使用，单次不超过设置上限。
4. 引用时给出 `seq` 或 `uuid`，便于用户核对。

工具 `searchHint`（供工具检索用）：
- `LcmGrep`: `search history transcript recall earlier messages keywords`
- `LcmDescribe`: `summary node span depth inspect`
- `LcmExpand`: `expand restore original text verbatim details`
