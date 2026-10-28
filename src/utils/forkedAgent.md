# runForkedAgent 逐行讲解（TypeScript → Python 对照）

面向 TypeScript 初学者的讲解。源文件：`src/utils/forkedAgent.ts`（717 行）。

---

## 0. 一句话心智模型

把「当前会话的完整历史 + 一条新指令」喂给一个**独立的子对话循环**（`query()`），让它跑完自己的多轮工具调用，把过程和用量收集起来返回，同时保证：

1. 它和父请求用**完全相同**的 system prompt / tools / model / 消息前缀 → 命中父级 prompt cache（省钱省延迟）
2. 它**不能污染**父会话的任何可变状态（读写文件缓存、UI 回调等全部隔离）

Python 类比：

```python
result = await run_forked_agent(
    prompt_messages=[user_msg],
    cache_safe_params=cache_safe_params,   # 从父上下文复制的"缓存关键参数"
    can_use_tool=perm,                     # 权限函数
    query_source="session_memory",
    fork_label="session_memory",
)
# result.messages / result.total_usage
```

---

## 1. 类型定义部分（`forkedAgent.ts:61-115`）

### 1.1 `CacheSafeParams`（`:61-72`）

```ts
export type CacheSafeParams = {
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext
  forkContextMessages: Message[]
}
```

Python 对照：

```python
from typing import TypedDict

class CacheSafeParams(TypedDict):
    systemPrompt: SystemPrompt
    userContext: dict[str, str]        # { [k: string]: string } = 键是 str、值是 str 的字典
    systemContext: dict[str, str]
    toolUseContext: ToolUseContext
    forkContextMessages: list[Message]  # Message[] = "Message 数组"
```

要点：
- `export type X = { ... }` ≈ Python 的 `TypedDict`（**只在编译期存在**，运行时没有任何对象，零开销）
- 想运行时也有东西就用 `class`（TS 里是 `interface` 或 `class`）。这里纯当"形状说明书"
- `T[]` = `list[T]`；`{ [k: string]: string }` = `dict[str, str]`（索引签名）
- 字段后面不带 `?` = 必填；带 `?` = 可选（≈ `Optional[T] = None`）

### 1.2 `ForkedAgentParams`（`:78-108`）

```ts
export type ForkedAgentParams = {
  promptMessages: Message[]
  cacheSafeParams: CacheSafeParams
  canUseTool: CanUseToolFn
  querySource: QuerySource
  forkLabel: string
  overrides?: SubagentContextOverrides   // ? 表示可选
  maxOutputTokens?: number
  maxTurns?: number
  onMessage?: (message: Message) => void  // 函数类型字段
  skipTranscript?: boolean
  skipCacheWrite?: boolean
}
```

Python 对照：

```python
class ForkedAgentParams(TypedDict, total=False):   # total=False ≈ 全部字段可选
    promptMessages: list[Message]
    cacheSafeParams: CacheSafeParams
    canUseTool: Callable[[Tool, object], Awaitable[PermissionResult]]  # CanUseToolFn
    querySource: str
    forkLabel: str
    overrides: SubagentContextOverrides | None
    maxOutputTokens: int | None
    maxTurns: int | None
    onMessage: Callable[[Message], None] | None
    skipTranscript: bool | None
    skipCacheWrite: bool | None
```

几个 TS 特有语法：

| TS 写法 | 含义 | Python 类比 |
|---|---|---|
| `field?: T` | 可选字段 | `Optional[T]` |
| `(message: Message) => void` | 函数类型（箭头） | `Callable[[Message], None]` |
| `T \| null` | 联合类型 | `T \| None` |
| `async (...) => Promise<void>` | 异步函数类型 | `Callable[..., Coroutine[Any, Any, None]]` |
| `as const` | 字面量类型收窄 | 类似 `Literal` |
| `x as SomeType` | 类型断言（骗编译器） | `cast(SomeType, x)`，运行时无操作 |

### 1.3 `ForkedAgentResult`（`:110-115`）

```ts
export type ForkedAgentResult = {
  messages: Message[]
  totalUsage: NonNullableUsage
}
```

≈ `NamedTuple` / `dataclass`，纯返回值容器。

---

## 2. `createCacheSafeParams`（`:126-136`）

```ts
export function createCacheSafeParams(context: REPLHookContext): CacheSafeParams {
  return {
    systemPrompt: context.systemPrompt,
    userContext: context.userContext,
    systemContext: context.systemContext,
    toolUseContext: context.toolUseContext,
    forkContextMessages: context.messages,
  }
}
```

就是个字段搬运工：从 hook 上下文里挑出 5 个"影响缓存 key"的字段。

```python
def create_cache_safe_params(context: REPLHookContext) -> CacheSafeParams:
    return CacheSafeParams(
        systemPrompt=context.systemPrompt,
        userContext=context.userContext,
        systemContext=context.systemContext,
        toolUseContext=context.toolUseContext,
        forkContextMessages=context.messages,
    )
```

`: CacheSafeParams` 是**返回类型注解**（在参数括号后面），等价于 Python 的 `-> CacheSafeParams`。

---

## 3. `createSubagentContext`（`:342-463`）—— 隔离是怎么做的

签名：

```ts
export function createSubagentContext(
  parentContext: ToolUseContext,
  overrides?: SubagentContextOverrides,
): ToolUseContext
```

返回一个**新的** `ToolUseContext`，默认把父上下文所有"可变/有副作用"的部分都换掉：

| 字段 | 处理 | 为什么 |
|---|---|---|
| `readFileState` | `cloneFileStateCache(...)` 克隆（`:380`） | fork 读到/写过文件不能影响父级的文件读取去重缓存 |
| `abortController` | 默认 `createChildAbortController(parent)`（`:351`） | 父级取消要能传播下来；但子级自己也能取消 |
| `getAppState` | 包一层，强制 `shouldAvoidPermissionPrompts: true`（`:359-371`） | 后台 fork 绝不能弹权限框 |
| `setAppState` | 默认 `() => {}` 空函数（`:412`） | fork 不能改父 UI 状态 |
| `setInProgressToolUseIDs` / `updateFileHistoryState` | 空函数（`:426`、`433`） | 同上 |
| `nestedMemoryAttachmentTriggers` 等 | `new Set()`（`:383-387`） | 全新的空集合 |
| `options` / `messages` / `agentId` | 可被 `overrides` 覆盖（`:446-450`） | 需要不同的模型/工具集时用 |
| `queryTracking` | 新 `chainId`，`depth = 父 depth + 1`（`:453-456`） | 遥测里区分调用链深度 |

TS 语法点：

```ts
const abortController =
  overrides?.abortController ??                       // ① 可选链 + 空值合并
    (overrides?.shareAbortController
      ? parentContext.abortController                 // ② 三元表达式
      : createChildAbortController(parentContext.abortController))
```

翻译成 Python：

```python
abort_controller = (
    overrides.abortController if overrides and overrides.abortController is not None
    else (
        parent_context.abortController
        if overrides and overrides.shareAbortController
        else create_child_abort_controller(parent_context.abortController)
    )
)
```

- `a?.b`：**可选链**。若 `a` 是 `null/undefined` 整个表达式直接是 `undefined`，不报错。≈ Python 的 `a.b if a else None`
- `x ?? y`：**空值合并**。仅当 `x` 是 `null/undefined` 时取 `y`。和 `||` 不同：`0`、`''`、`false` 不会被 `??` 替换掉。≈ `x if x is not None else y`

还有一处常见的：

```ts
setAppState: overrides?.shareSetAppState ? parentContext.setAppState : () => {},
```

`() => {}` 是空箭头函数，`{}` 是函数体（不是字典！）。≈ Python `lambda: None`。

---

## 4. 类型守卫 `isMessageDeltaStreamEvent`（`:496-506`）

```ts
function isMessageDeltaStreamEvent(
  message: Message | StreamEvent,
): message is StreamEventMessage & { event: BetaRawMessageDeltaEvent } {
  return (
    message.type === 'stream_event' &&
    typeof (message as StreamEventMessage).event === 'object' &&
    ...
    (message as StreamEventMessage).event.type === 'message_delta'
  )
}
```

关键在返回类型 `message is X`：**类型谓词（type guard）**。意思是"如果这个函数返回 true，编译器就相信 `message` 是 `X`"，后续可以直接访问 `.event.usage` 而不用再断言。

Python 里没有对应语法，只能手写：

```python
def is_message_delta_stream_event(message) -> bool:
    return (message.get("type") == "stream_event"
            and isinstance(message.get("event"), dict)
            and message["event"].get("type") == "message_delta")

# 调用处：Python 里没有自动窄化，得自己 cast
if is_message_delta_stream_event(msg):
    usage = cast(dict, msg["event"])["usage"]
```

`A & B` 是**交叉类型**（既是 A 又是 B），≈ Python 的 `class C(A, B)` 多继承语义。

---

## 5. 主函数 `runForkedAgent`（`:508-653`）

### 5.1 函数签名与解构（`:508-520`）

```ts
export async function runForkedAgent({
  promptMessages,
  cacheSafeParams,
  canUseTool,
  querySource,
  forkLabel,
  overrides,
  maxOutputTokens,
  maxTurns,
  onMessage,
  skipTranscript,
  skipCacheWrite,
}: ForkedAgentParams): Promise<ForkedAgentResult> {
```

TS 特色：**参数解构**——调用方传一个对象，函数直接把字段拆成局部变量。

Python 等价（最接近的写法）：

```python
async def run_forked_agent(**params) -> ForkedAgentResult:
    prompt_messages = params["promptMessages"]     # 必填，缺失就 KeyError
    max_turns = params.get("maxTurns")             # 可选 → None
    ...
```

或者用 dataclass + 手动取属性。Python 没有结构化解构，这也是 TS 最舒服的地方之一。

`async function ... : Promise<ForkedAgentResult>` ≈ `async def ... -> ForkedAgentResult`。

### 5.2 初始化（`:521-531`）

```ts
const startTime = Date.now()
const outputMessages: Message[] = []
let totalUsage: NonNullableUsage = { ...EMPTY_USAGE }

const { systemPrompt, userContext, systemContext, toolUseContext, forkContextMessages } = cacheSafeParams
```

- `const` = 不可重新绑定（≈ Python 里约定不重新赋值的变量；**注意对象内容仍可改**）
- `let` = 可重新赋值
- `{ ...EMPTY_USAGE }` = **对象展开**，做浅拷贝。≈ Python `{**EMPTY_USAGE}`
- `Date.now()` ≈ `time.time() * 1000`（毫秒）

### 5.3 建隔离上下文（`:534-537`）

```ts
const isolatedToolUseContext = createSubagentContext(toolUseContext, overrides)
```

### 5.4 拼初始消息（`:543`）——缓存命中的关键

```ts
const initialMessages: Message[] = [...forkContextMessages, ...promptMessages]
```

≈ Python `initial_messages = [*fork_context_messages, *prompt_messages]`

父会话历史在前、新指令在后。Anthropic 的 prompt cache 按**前缀**匹配，所以这个顺序保证了前缀与父请求一致 → cache hit。

旁边 `:539-542` 的注释解释了为什么**不**在这里过滤不完整的工具调用：会丢掉配对的 tool_result 导致 API 400，交给下游 `ensureToolResultPairing` 修复，且"父子做同样的修复"才能保持前缀一致。

### 5.5 侧链 transcript（`:547-560`）

```ts
const agentId = skipTranscript ? undefined : createAgentId(forkLabel)
let lastRecordedUuid: UUID | null = null
if (agentId) {
  await recordSidechainTranscript(initialMessages, agentId).catch(err =>
    logForDebugging(`Forked agent [${forkLabel}] failed to record initial transcript: ${err}`),
  )
  lastRecordedUuid = initialMessages.length > 0 ? initialMessages[initialMessages.length - 1]!.uuid : null
}
```

- `` `...${forkLabel}...` `` 是**模板字符串**，≈ Python f-string
- `.catch(err => ...)` ≈ Python 的 `try/except` 包一层；等价写法：

```python
try:
    await record_sidechain_transcript(initial_messages, agent_id)
except Exception as e:
    log_for_debugging(f"Forked agent [{fork_label}] failed: {e}")
```

- `initialMessages[len-1]!` 的 `!` 是**非空断言**："我保证不是 undefined"。≈ Python 里的 `# type: ignore`（运行时无操作，用错就 undefined 崩溃）
- `UUID | null` 里的 `UUID` 来自 `import type { UUID } from 'crypto'`（`:11`）——`import type` 只导入类型，编译后消失

### 5.6 主循环（`:563-625`）——最重要的部分

```ts
try {
  for await (const message of query({
    messages: initialMessages,
    systemPrompt,
    userContext,
    systemContext,
    canUseTool,
    toolUseContext: isolatedToolUseContext,
    querySource,
    maxOutputTokensOverride: maxOutputTokens,
    maxTurns,
    skipCacheWrite,
  })) {
    if (message.type === 'stream_event') {
      if (isMessageDeltaStreamEvent(message)) {
        const turnUsage = updateUsage({ ...EMPTY_USAGE }, message.event.usage)
        totalUsage = accumulateUsage(totalUsage, turnUsage)
      } else {
        const event = (message as StreamEventMessage).event
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          const textLength = event.delta.text.length
          isolatedToolUseContext.setResponseLength(len => len + textLength)
        }
      }
      continue
    }
    if (message.type === 'stream_request_start') continue

    outputMessages.push(message as Message)
    onMessage?.(message as Message)
    ...
  }
} finally {
  isolatedToolUseContext.readFileState.clear()
  initialMessages.length = 0
}
```

Python 等价：

```python
try:
    async for message in query(
        messages=initial_messages,
        systemPrompt=system_prompt,
        userContext=user_context,
        systemContext=system_context,
        canUseTool=can_use_tool,
        toolUseContext=isolated_tool_use_context,
        querySource=query_source,
        maxOutputTokensOverride=max_output_tokens,
        maxTurns=max_turns,
        skipCacheWrite=skip_cache_write,
    ):
        if message["type"] == "stream_event":
            if is_message_delta_stream_event(message):
                turn_usage = update_usage({**EMPTY_USAGE}, message["event"]["usage"])
                total_usage = accumulate_usage(total_usage, turn_usage)
            else:
                event = message["event"]
                if event["type"] == "content_block_delta" and event["delta"]["type"] == "text_delta":
                    n = len(event["delta"]["text"])
                    isolated_tool_use_context.set_response_length(lambda length: length + n)
            continue

        if message["type"] == "stream_request_start":
            continue

        output_messages.append(message)
        if on_message:
            on_message(message)
        ...
finally:
    isolated_tool_use_context.readFileState.clear()
    initial_messages.clear()
```

必须理解的 4 个点：

1. **`for await ... of` ≈ `async for ... in`**：`query()` 是**异步生成器**（函数里有 `yield`），每产出一条消息循环体执行一次。Python 里就是 `async def` + `yield` 的异步生成器。
2. **`message.event.usage` 能直接访问**，靠的是 `:496` 那个 type guard 在 `if` 里把类型收窄了（第 4 节）。
3. **`onMessage?.(message)`**：`?.()` 是"函数存在才调用"。≈ Python 的 `if on_message: on_message(message)`。这是 TS 很常见的可选回调写法。
4. **`try { ... } finally { ... }`**：和 Python 完全一样。`finally` 里释放克隆的文件状态缓存、清空消息数组（防止大数组一直被引用）。注意这里**没有 catch**——异常会继续往外抛给调用方，但 `finally` 一定执行。

循环里每条 `assistant`/`user`/`progress` 消息还会增量写 transcript（`:609-624`），靠 `lastRecordedUuid` 维持父子链顺序。

### 5.7 收尾与打点（`:633-652`）

```ts
const durationMs = Date.now() - startTime

logForkAgentQueryEvent({ forkLabel, querySource, durationMs, messageCount: outputMessages.length, totalUsage, queryTracking: toolUseContext.queryTracking })

return { messages: outputMessages, totalUsage }
```

`{ forkLabel, querySource, ... }` 是**简写属性**：键名 = 变量名。≈ Python 没有简写，得写全；`durationMs` 这种驼峰在 Python 里是 `duration_ms`。

`logForkAgentQueryEvent`（`:658-716`）就是算个缓存命中率再 `logEvent('tengu_fork_agent_query', {...})`。里面的 `forkLabel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` 是**类型断言**（`:685`），用来通过一个"防止把代码/路径误当遥测字段"的品牌类型检查——运行时什么都没发生。

---

## 6. TS ↔ Python 速查表（本文用到的）

| TypeScript | Python | 备注 |
|---|---|---|
| `export type X = {...}` | `class X(TypedDict)` | 编译期类型，运行时消失 |
| `export interface X {...}` | `class X(TypedDict)` / Protocol | 同上，可被 `implements` |
| `T[]` | `list[T]` | |
| `{ [k: string]: T }` | `dict[str, T]` | 索引签名 |
| `foo?: T` | `Optional[T]` | 可选字段 |
| `A \| B` | `A \| B` | 联合类型 |
| `A & B` | 多继承语义 | 交叉类型 |
| `x as T` | `cast(T, x)` | 类型断言，运行时无操作 |
| `x!.y` | `x.y  # type: ignore` | 非空断言 |
| `a?.b` | `a.b if a else None` | 可选链 |
| `a ?? b` | `a if a is not None else b` | 空值合并 |
| `fn?.()` | `if fn: fn()` | 可选调用 |
| `{...a, ...b}` / `[...a, ...b]` | `{**a, **b}` / `[*a, *b]` | 展开 |
| `const {a, b} = obj` | 无直接对应（手写取属性） | 解构 |
| `function f({a, b}: P)` | `def f(**params)` 后手动取 | 参数解构 |
| `` `a${x}b` `` | `f"a{x}b"` | 模板字符串 |
| `(x) => x + 1` | `lambda x: x + 1` | 箭头函数 |
| `async function` / `Promise<T>` | `async def` / `Coroutine[..., T]` | |
| `for await (const x of g)` | `async for x in g` | 异步迭代 |
| `p.catch(e => ...)` | `try/except` 包裹 | Promise 的错误分支 |
| `try/finally`（无 catch） | `try/finally` | 一样 |
| `function f(x): x is T` | 无（得手写 cast） | 类型谓词 |
| `Set<T>` / `Map<K,V>` | `set` / `dict` | |
| `import type { X }` | `if TYPE_CHECKING` | 只导入类型 |

---

## 7. 调用方视角（两个实例）

```ts
// src/services/SessionMemory/sessionMemory.ts:325
await runForkedAgent({
  promptMessages: [createUserMessage({ content: userPrompt })],
  cacheSafeParams: createCacheSafeParams(context),
  canUseTool: createMemoryFileCanUseTool(memoryPath),   // 只能 Edit 那一个笔记文件
  querySource: 'session_memory',
  forkLabel: 'session_memory',
  overrides: { readFileState: setupContext.readFileState },
})
```

```ts
// src/services/extractMemories/extractMemories.ts:412
const result = await runForkedAgent({
  promptMessages: [createUserMessage({ content: userPrompt })],
  cacheSafeParams,
  canUseTool,
  querySource: 'extract_memories',
  forkLabel: 'extract_memories',
  skipTranscript: true,   // 不落 transcript，避免与主线程竞态
  maxTurns: 5,            // 硬上限，防跑飞
})
```

两点注意：

- `await` 是**阻塞等待**——session memory 那里是 `await`，所以 hook 会等它跑完
- 而 `extractMemories` 的调用方（`src/query/stopHooks.ts:152`）用的是 `void import(...).then(...)`：`void` 表示"我故意不 await，让它后台跑"（fire-and-forget）

---

## 8. 三个最容易踩的坑

1. **`const` 不等于不可变**：`const arr = []` 后 `arr.push(x)` 完全合法，只是不能 `arr = 别的`。要真冻结得用 `Object.freeze` 或 TS 的 `readonly T[]`。
2. **`?.` 和 `??` 只对 `null`/`undefined` 生效**：`0`、`''`、`false`、`NaN` 都是"有效值"，不会被 `??` 替换；但会被 `||` 替换（这是初学者最常写错的地方）。
3. **类型只在编译期**：`as`、type guard、`!` 全部在 `bun build` 后被抹掉。运行时类型错了就是 `undefined.xxx` 崩溃，没有任何检查。

---

## 9. 并发模型：到底有没有新线程 / 新协程？

**结论：`runForkedAgent` 全程不创建任何 OS 线程、子进程或 Worker。** 在 `src/utils/forkedAgent.ts` 里搜索 `new Worker` / `worker_threads` / `Bun.spawn` / `child_process` 结果为空。

### 9.1 运行时背景

Bun（和 Node）是**单线程事件循环**：所有 JS 代码都在同一个线程上执行，`await` 只是"让出控制权"，让事件循环去处理别的已就绪任务。

| 概念 | JS/Bun | Python 对照 |
|---|---|---|
| 事件循环 | libuv / Bun 运行时 | `asyncio.get_event_loop()` |
| `async function` | 返回 Promise 的协程 | `async def` |
| `await` | 让出事件循环 | `await` |
| 不 await 直接调用 | Promise 挂起、后台推进 | `asyncio.create_task(fn())` |
| `Promise.all([...])` | 并发等待多个 | `asyncio.gather(...)` |
| `new Worker` | **真 OS 线程**（有独立事件循环） | `threading.Thread` / `ProcessPoolExecutor` |
| `Bun.spawn` | **真子进程** | `subprocess.Popen` |

所以 `runForkedAgent` 里的 "fork" 是**逻辑上的分叉**（复制消息与上下文、共享 prompt cache），不是 `fork()` 系统调用，也不是线程分叉。

### 9.2 并发是怎么发生的

关键在于调用方**不 await**：

- `src/query.ts:1318` — `void executePostSamplingHooks(...)`：主线程 query loop 立刻继续，session memory 的 hook 在后台推进
- `src/query/stopHooks.ts:152` — `void import(...).then(...)`：extract_memories 同样 fire-and-forget

`void promise` 是 TS 惯用写法，表示"故意丢弃这个 Promise，不等它"。等价于 Python 里 `asyncio.create_task(coro)` 后不 await。

真正的"同时推进"只发生在 **I/O 等待**期间：fork 发起 API 请求后 `await` 网络响应，此时事件循环回到主线程继续跑 REPL。JS 代码本身永远只有一个在执行。

### 9.3 那"并行"的部分在哪

只有三类真实并行（都不在 JS 层）：

1. **网络 I/O**：HTTP 流式响应由内核 + Bun 运行时处理，回调仍回到主线程
2. **文件 I/O**：`recordSidechainTranscript` 等异步 fs 操作，Bun 内部可能用线程池
3. **工具生成的子进程**：fork 里若调用了 `BashTool`，那会 spawn 真 OS 进程。session memory 只允许 `Edit`（无子进程）；extract_memories 允许只读 Bash（`extractMemories.ts:194`），会 spawn

### 9.4 为什么代码里到处是"标志位"而不是锁

单线程意味着**没有真正的内存竞态**（不会出现两个线程同时写同一个变量），只有"await 之间状态被别人改了"的**逻辑竞态（可重入问题）**。所以：

- `sessionMemory.ts:273` 用 `sequential()`（`src/utils/sequential.ts:19`）——它只是一个 Promise 队列（数组 + `processing` 布尔位），不是互斥锁
- `extractMemories.ts:309` 用 `inProgress` 布尔 + `pendingContext` 暂存——同样的手法
- `abortController`（`forkedAgent.ts:351`）是纯 JS 对象，取消靠事件传播，不是线程中断

### 9.5 实际风险：CPU 密集代码会卡住 REPL

因为只有一个线程，**任何同步的 CPU 密集代码都会阻塞整个 UI**，包括 fork 触发前跑的那些：

- `tokenCountWithEstimation(messages)`（`sessionMemory.ts:138`）
- `scanMemoryFiles()`（`extractMemories.ts:396`）
- `applyToolResultBudget()`（`src/query.ts:588`）

长会话下这些同步计算会造成可感知的输入卡顿——这也是它们被放在节流判断之后（`:374-382`）的原因之一：被跳过的轮次不该付出扫描成本。
