# WebFetchTool/utils.ts —— 为什么 tool_result 是 "No response from model"

> 现象：WebFetch 调用"执行完成"（没有报错、没有红色 tool_use_error），但回给模型的消息是
> `role: "tool", content: "No response from model", tool_call_id: "call_046d1078b81248e8ba1f4ce7"`，
> 而不是抓取到的网页内容。

## 1. 这句话的唯一出处

`packages/builtin-tools/src/tools/WebFetchTool/utils.ts:592` —— `applyPromptToMarkdown()` 的兜底返回值：

```581:593:packages/builtin-tools/src/tools/WebFetchTool/utils.ts
  const { content } = assistantMessage.message!
  if (content!.length > 0) {
    const contentBlock = content![0]
    if (
      contentBlock &&
      typeof contentBlock === 'object' &&
      'text' in contentBlock
    ) {
      return (contentBlock as { text: string }).text
    }
  }
  return 'No response from model'
```

也就是说：**二级模型（Haiku / small fast model）返回了消息，但 `message.content[0]` 不是 text 块**（或 `content` 为空数组）→ 直接返回这串兜底文案。

## 2. 它为什么会被当成"成功结果"回传

调用链（`WebFetchTool.ts`）：

```210:278:packages/builtin-tools/src/tools/WebFetchTool/WebFetchTool.ts
  async call({ url, prompt }, { abortController, options: { isNonInteractiveSession } }) {
    ...
    const backend = settings.webFetchAdapter ?? 'tavily'   // :217-218 默认 tavily
    const response = await fetchContentWithTavily(url, abortController)  // :222
    let result = content                                    // :253
    if (prompt && prompt.trim()) {
      result = await applyPromptToMarkdown(...)             // :257  ← 兜底串在这里产生
    }
    const output: Output = { bytes, code, codeText, result, durationMs, url }  // :270
    return { data: output }
  }
```

- `applyPromptToMarkdown` **不抛错**，返回普通字符串 → 工具认为执行成功。
- `WebFetchTool.ts:368-374` 的 `mapToolResultToToolResultBlockParam` 只写 `{ type:'tool_result', content: result }`，**不设 `is_error`**。
- 因此模型看到的是一个"正常成功"的 tool_result，内容却是 4 个单词，无法感知失败，只能据此继续作答。

反证：如果问题出在**抓取阶段**，会走另一条路 —— `fetchContentWithTavily` 在正文为空时 **throw**（`utils.ts:524-528`），被 `toolExecution.ts` 捕获后生成 `is_error: true` 的 `<tool_use_error>Tavily Extract returned empty content for ...</tool_use_error>`。既然你看到的是 "No response from model"，说明 **URL 抓取是成功的**，失败点在"总结"这一步。

## 3. 触发条件（按可能性排序）

1. **首个 content 块不是 text（thinking / reasoning 块排在最前）** —— **已修复，见第 5 节**
   旧代码只看 `content[0]`（原 `utils.ts:582-591`），一旦小模型先吐 thinking 块就命中兜底。
   OpenAI 兼容层对 `deepseek` / `mimo` 模型会**自动开启 thinking**（`src/services/api/openai/requestBody.ts:21-31`、`:110-117`），thinking 块通常排在正文之前。
2. **content 为空数组**
   例如兼容端点返回 `content: null`（只出 tool_calls / reasoning），或 thinking 把 `max_tokens` 吃光导致正文没生成（见 `src/services/api/openai/index.ts:331-340` 的注释与 `resolveOpenAIMaxTokens`）。
3. **页面本身无可总结内容**
   `x.com` 需要登录/JS 渲染，Tavily 常常只能拿到登录墙或极短正文；小模型可能返回空/拒答。
4. **二级模型调用异常被吞成空消息**
   `queryHaiku`（`src/services/api/claude.ts:3485`）→ `queryModelWithoutStreaming`（`:3514`）；若端点返回异常形态的 assistant 消息，也会落到兜底分支。

二级模型是谁：`queryHaiku` 用 `getSmallFastModel()`（`claude.ts:3522`），取值优先级见
`src/utils/model/model.ts:67-87`：`OPENAI_SMALL_FAST_MODEL`（provider=openai）→ `GEMINI_SMALL_FAST_MODEL` → `ANTHROPIC_SMALL_FAST_MODEL` → 默认 Haiku。

## 4. 顺带一提：WebFetch 的最终文本永远不是网页原文

只要 `WebFetch(url, prompt)` 带了 `prompt`（本例带了），Tavily 拿到的 Markdown **必定再经过一次小模型总结**（`WebFetchTool.ts:254-264`），模型看到的是摘要而非原网页。只有 `prompt` 为空时 `result` 才是原始正文（`WebFetchTool.ts:253`）。

## 5. 根因（已复现）与已实施的修复

### 5.1 复现结果：不是模型名的问题

把 `~/.claude/settings.json` 的 env 注入 process.env（`enableConfigs()` + `applySafeConfigEnvironmentVariables()`）后实测：

```text
getSmallFastModel()   = qwen3.5-plus      ← 已经是配置里的模型
WebFetchTool.call()   → result: "No response from model"
```

也就是说**模型名是对的，仍然兜底**。换模型（`claude.ts:3523` 指定 qwen3.5-plus）不会解决这个现象。

### 5.2 真正的根因：二级模型返回了 thinking 块

实测 `queryHaiku` 的原始 `message.content`（qwen3.5-plus）：

```text
#0 type=thinking  thinking(11489 字符)                 ← 思考过程
#1 type=text      text="我是一个人工智能"                ← 正文前半段
#2 type=thinking  thinking="" text="助手，致力于…"       ← 正文后半段被塞进 thinking 块
```

两个坑：

1. **`content[0]` 是 thinking 块** → 旧代码 `utils.ts:586-595` 只检查 `content[0]` 有没有 `text` 字段，直接走到 `return 'No response from model'`。
2. **OpenAI 兼容层的流适配器把正文尾部的 `text_delta` 追加到了已打开的 thinking 块上** —— 表现为 `type:'thinking'`、`thinking` 为空、却带 `text`（`src/services/api/openai/index.ts:455-471` 的 `content_block_delta` 只按 `delta.type` 追加，不校验目标块类型）。所以即使"跳过 thinking 块"也会把正文后半段丢掉。

### 5.3 已实施的修复

- `packages/builtin-tools/src/tools/WebFetchTool/utils.ts:584-604`：`applyPromptToMarkdown` 不再只看 `content[0]`，而是**收集所有带非空 `text` 的块并拼接**（不按 `type` 过滤，以兼容 5.2 第 2 点）；只有完全没有 text 时才兜底 `No response from model`。
- `src/utils/model/model.ts:67-108`：`getSmallFastModel()` 的 openai 分支显式从 `~/.claude/settings.json` 的 env 取模型 —— `OPENAI_SMALL_FAST_MODEL` > `OPENAI_DEFAULT_HAIKU_MODEL`（当前值 qwen3.5-plus），不再让 OpenAI 兼容端点回落到 Anthropic 内置名 `claude-haiku-4-5-*`。纯函数 `resolveOpenAISmallFastModel()` 便于单测。

修复后实测：

```text
small fast model = qwen3.5-plus
result = "该页面说明此域名旨在用于文档示例，无需许可。它并非一项服务，应避免依赖它进行测试或监控。"
```

### 5.4 仍未实施（建议）

- 兜底时**抛错**或标记 `Output` 失败，让 `mapToolResultToToolResultBlockParam` 产出 `is_error: true`，模型才能感知并改用 WebSearch/重试。
- 修 OpenAI 兼容层的流适配器：thinking 块未关闭时收到 `text_delta` 应新开 text 块（`src/services/api/openai/index.ts:455-471`），否则主循环对话的正文也可能被错位写入 thinking 块。

## 6. 如何测试这个工具（WebFetch）

### 6.1 仓库里现有的测试手段

| 手段 | 位置 | 覆盖到哪一层 |
|---|---|---|
| 就近单测 | `packages/builtin-tools/src/tools/WebFetchTool/__tests__/`（原只有 `headers.test.ts`、`preapproved.test.ts`、`urlValidation.test.ts`） | `utils.ts` 的 URL 校验 / 重定向 / 预批准域名，**没有** `call()` 与 `applyPromptToMarkdown()` |
| 新增单测 | `__tests__/applyPromptToMarkdown.test.ts`（本次新增，10 例） | `applyPromptToMarkdown()` + `WebFetchTool.call()`（tavily 后端）+ `mapToolResultToToolResultBlockParam()` |
| 集成测试 | `tests/integration/tool-chain.test.ts` | 只做工具注册/发现（`getAllBaseTools` / `findToolByName`），**不执行** `call()` |
| 共享 mock | `tests/mocks/axios.ts`（`setupAxiosMock`）、`tests/mocks/log.ts`、`tests/mocks/toolContext.ts`（`mockToolContext`，给 `checkPermissions` 用） | — |

也就是说：**仓库里没有"手工单跑某个工具"的 CLI/脚本入口**（`scripts/` 下只有 `dev.ts` / `build` / `health-check` 之类，没有 tool-runner）。想直接驱动工具，要么写单测，要么临时写脚本（6.3）。

### 6.2 执行某个单测

```bash
# 单个文件
bun test packages/builtin-tools/src/tools/WebFetchTool/__tests__/applyPromptToMarkdown.test.ts

# 按用例名过滤（只跑名字匹配的用例）
bun test packages/builtin-tools/src/tools/WebFetchTool/__tests__/applyPromptToMarkdown.test.ts -t "No response from model"

# 整个工具目录（4 个文件 / 50 例）
bun test packages/builtin-tools/src/tools/WebFetchTool

# 整个包（47 文件 / 641 例）
bun test packages/builtin-tools

# 全量
bun test
```

说明：
- 测试框架是 `bun:test`（`bunfig.toml` 里 `[test] timeout = 10000`，单用例超时 10s）。
- `bun test` 会注入 `NODE_ENV=test`，此时 `learningLog` 静默（见 `src/utils/learningLog.ts:59-71`），不会写日志文件。
- `mock.module()` 在 Bun 里是**进程级全局**的：同目录其他文件也会注册 mock，所以本测试文件刻意只 mock 下层（axios / settings / log / analytics / http / mcpOutputStorage）与三个直接邻居（`src/Tool.js`、`src/utils/permissions/permissions.js`、`UI.tsx`），并在文件顶层就 `await import('../WebFetchTool')`，避免被后续注册的同名 mock 影响（曾出现 `Export named 'getSettingsForSource' not found` 的跨文件污染）。

### 6.3 手工驱动这个工具（临时脚本）

在仓库根目录新建 `scratch/manual-webfetch.ts`（用后删除；必须用仓库内路径，`src/*` 别名才生效 —— 见 `tsconfig.json` 的 `paths`）：

```ts
import { WebFetchTool } from '../packages/builtin-tools/src/tools/WebFetchTool/WebFetchTool'
import { getSmallFastModel } from '../src/utils/model/model'

const url = process.argv[2] ?? 'https://x.com/addyosmani/status/2114604912520921136'
const prompt = process.argv[3] ?? '总结这篇推文的主要内容'
console.log('small fast model =', getSmallFastModel())

const ctx = { abortController: new AbortController(), options: { isNonInteractiveSession: true } } as never
try {
  const { data } = await WebFetchTool.call({ url, prompt }, ctx)
  console.log(JSON.stringify(data, null, 2).slice(0, 2000))
  console.log(WebFetchTool.mapToolResultToToolResultBlockParam(data, 'manual-1'))
} catch (e) {
  console.error('工具抛错（会变成 is_error tool_result）:', e)
}
```

```bash
bun run scratch/manual-webfetch.ts
```

实际跑过一次（本机）输出：

```text
small fast model = claude-haiku-4-5-20251001
{ "bytes": 47872, "code": 200, "codeText": "OK",
  "result": "API Error: Connection error.", "durationMs": 76169, "url": "https://x.com/..." }
{ "tool_use_id": "manual-1", "type": "tool_result", "content": "API Error: Connection error." }
```

两点信息量：

1. **Tavily 抓取是成功的**（`bytes: 47872, code: 200`）—— 再次证明失败点在二级模型，不在抓取。
2. 本机连不上 Anthropic 时，二级模型调用的错误**没有抛出**，而是被 `queryHaiku` 返回成一条内容为 `API Error: Connection error.` 的 assistant 消息 → 经 `utils.ts:585-592` 成为 `result`，最终仍是一条**不带 `is_error`** 的 tool_result。也就是说"API 层故障"和"模型没吐文本"在这条链路上对模型是同构的，都无法被感知为失败。若要区分，需要在 `applyPromptToMarkdown` 里检查 `assistantMessage.error` 或空文本并主动抛错。
