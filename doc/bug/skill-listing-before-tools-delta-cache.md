# 修复：tools message 未排在 skill listing 之后导致 prompt cache 失效

## 用户原始 query

> 修复bug， tools 的message 没有在 <system-reminder> The following skills are available for use with the Skill tool: 之后，被 用户输入插入了，导致缓存失效

## 问题根因

在 `src/utils/attachments.ts` 的 `getAttachments()` 中，`allThreadAttachments` 数组按顺序生成各类附件消息，这些附件最终在 `normalizeMessagesForAPI()`（`src/utils/messages.ts`）里经过 `reorderAttachmentsForAPI()` 被上浮，并合并为**一条位于用户真实输入之前的前置 user message**，构成 prompt cache 的前缀。

原顺序中，三类「能力变更」delta 附件排在 `skill_listing` 之前：

1. `deferred_tools_delta` —— "The following deferred tools are now available: ..."（tools message）
2. `agent_listing_delta` —— "Available agent types for the Agent tool: ..."
3. `mcp_instructions_delta` —— "# MCP Server Instructions ..."
4. `skill_listing` —— "The following skills are available for use with the Skill tool: ..."

其中 `skill_listing` 是**只在 turn-0 发送一次、内容稳定**的公告；而三个 delta 附件是**可变**的，会在工具 / 代理 / MCP server 变化（含 compact 后被重新注入）时再次触发。由于 delta 排在 `skill_listing` 之前，一旦某个 delta 触发（内容变化），位于其后的稳定 `skill_listing` 也会随之被推离缓存前缀，导致整段 prompt cache 失效。

## 涉及文件与行号

- `src/utils/attachments.ts`
  - 原位置：`getAttachments()` 内 `allThreadAttachments` 数组
  - `skill_listing`：原在第 ~927 行（`dynamic_skill` 之后）
  - `deferred_tools_delta`：第 ~888 行
  - `agent_listing_delta`：第 ~903 行
  - `mcp_instructions_delta`：第 ~906 行

## 修复方案

将 `skill_listing` 附件上移到 `deferred_tools_delta` / `agent_listing_delta` / `mcp_instructions_delta` **之前**，使稳定的 skills 公告锚定在缓存前缀头部，tools/agents/MCP 的可变 delta 排在它之后。修复后的顺序：

```
skill_listing → deferred_tools_delta → agent_listing_delta → mcp_instructions_delta
```

## 验证命令与结果

```bash
bunx tsc --noEmit   # 通过，0 错误
```

（`read_lints` 对 `src/utils/attachments.ts` 返回 0 诊断）
