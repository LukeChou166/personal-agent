export const LCM_GREP_TOOL_NAME = 'LcmGrep'
export const LCM_DESCRIBE_TOOL_NAME = 'LcmDescribe'
export const LCM_EXPAND_TOOL_NAME = 'LcmExpand'

export const LCM_GREP_PROMPT = `在本地无损历史中按关键词检索当前会话（含已被摘要覆盖的消息）。

用法：
- 先用它定位（返回 seq / uuid / 片段 / 覆盖该消息的摘要节点 id）
- 需要原文时再用 LcmExpand
- 无命中返回空数组，不报错；跨会话内容不可见`

export const LCM_DESCRIBE_PROMPT = `查看一个摘要节点覆盖的范围、层级与正文。

返回：节点元数据、最多 20 个子节点、可展开的原文 token 估算。
节点损坏时仍返回元数据（status=corrupt），不会抛错。`

export const LCM_EXPAND_PROMPT = `把摘要节点（或其覆盖的消息）还原成原文片段。

- 按 seq 正序拼接，每条前缀 [seq/uuid/role]
- 超过 max_tokens 会截断并返回 next.start_seq，可继续展开
- 单次上限受设置 maxExpandTokens 约束`
