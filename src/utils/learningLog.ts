/**
 * learning 链路日志。
 *
 * 用途：沿着「命令行 → REPL → query → claude.ts 模型流式调用」这条主链路打点，
 * 帮助理解一次请求在本仓库中的完整执行路径。每条日志统一以 `[learning]` 开头，
 * 便于 `grep learning` 顺序还原链路：
 *
 *   [learning] +1234ms cli.startup argv=...
 *   [learning] +1240ms main.session_mode isInteractive=true
 *   ...
 *   [learning] +1300ms api.http_request_sent model=... max_tokens=32000
 *   [learning] +1400ms api.message_start ttftMs=98 inputTokens=12345
 *
 * 查看方式（默认常开，写入文件，不污染终端）：
 *
 *   tail -f ~/.claude/debug/learning-latest.log
 *
 * 控制开关：
 *   - CLAUDE_CODE_LEARNING_LOG=off|0|false  关闭
 *   - CLAUDE_CODE_LEARNING_LOG_FILE=<path>  指定日志文件（默认 ~/.claude/debug/learning-<时间戳>.log）
 *   - NODE_ENV=test                         静默（避免单测写文件/泄漏句柄）
 *
 * 依赖边界：本模块刻意不依赖 log.ts / debug.ts / bootstrap/state.ts —— 它们有模块级
 * 副作用（realpathSync / randomUUID），会把 mock 负担扩散到所有下游测试。
 * 这里只用 fs / path / bufferedWriter / cleanupRegistry / envUtils。
 */
import { appendFileSync, mkdirSync, symlinkSync, unlinkSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { type BufferedWriter, createBufferedWriter } from './bufferedWriter.js'
import { registerCleanup } from './cleanupRegistry.js'
import { getClaudeConfigHomeDir } from './envUtils.js'

/** 日志前缀 */
const PREFIX = '[learning]'
/** 单个 field 值的字符上限，超出则只保留长度与截断摘要 */
const MAX_FIELD_CHARS = 200
/** 缓冲写参数：SSE delta 是热路径，必须批量落盘 */
const FLUSH_INTERVAL_MS = 200
const MAX_BUFFER_SIZE = 256

// Lazy 而非顶层 const，避免模块加载期副作用。
let startTime = 0
let writer: BufferedWriter | null = null
let cachedLogPath: string | null = null
let ensuredDir: string | null = null
let symlinkCreated = false

function elapsedMs(): number {
  if (startTime === 0) {
    startTime = Date.now()
  }
  return Date.now() - startTime
}

/**
 * 是否记录 learning 日志。默认开启；测试环境（bun test 会注入 NODE_ENV=test）
 * 与显式关闭时静默。
 */
export function isLearningLogEnabled(): boolean {
  if (process.env.NODE_ENV === 'test') {
    return false
  }
  const flag = process.env.CLAUDE_CODE_LEARNING_LOG
  if (flag !== undefined && flag !== '') {
    const normalized = flag.toLowerCase().trim()
    if (['0', 'off', 'false', 'no'].includes(normalized)) {
      return false
    }
  }
  return true
}

function timestampSlug(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/**
 * 当前会话的 learning 日志文件路径。懒计算，模块加载时不产生 IO。
 */
export function getLearningLogPath(): string {
  if (cachedLogPath) {
    return cachedLogPath
  }
  const override = process.env.CLAUDE_CODE_LEARNING_LOG_FILE
  cachedLogPath = override
    ? resolve(override)
    : join(
        getClaudeConfigHomeDir(),
        'debug',
        `learning-${timestampSlug(new Date())}.log`,
      )
  return cachedLogPath
}

/** 折叠空白，保证一行一条日志 */
function toSingleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** 超长内容只保留长度与截断摘要，避免把 prompt/消息正文整个落盘 */
function truncate(value: string): string {
  const oneLine = toSingleLine(value)
  if (oneLine.length <= MAX_FIELD_CHARS) {
    return oneLine
  }
  return `<${oneLine.length} chars> ${oneLine.slice(0, MAX_FIELD_CHARS)}…`
}

function formatFieldValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  switch (typeof value) {
    case 'string':
      return truncate(value)
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value)
    case 'function':
      return undefined
    default:
      break
  }
  if (value instanceof Error) {
    return truncate(`${value.name}: ${value.message}`)
  }
  if (Array.isArray(value)) {
    return truncate(value.map(item => String(item)).join(','))
  }
  try {
    return truncate(JSON.stringify(value))
  } catch {
    return '[unserializable]'
  }
}

/** 维护 learning-latest.log 软链，方便固定路径 tail -f */
function updateLatestSymlink(dir: string, path: string): void {
  if (symlinkCreated) {
    return
  }
  symlinkCreated = true
  try {
    const latest = join(dir, 'learning-latest.log')
    try {
      unlinkSync(latest)
    } catch {
      // 软链不存在，忽略
    }
    symlinkSync(path, latest)
  } catch {
    // 软链失败不影响主流程
  }
}

function getWriter(): BufferedWriter {
  if (!writer) {
    writer = createBufferedWriter({
      writeFn: content => {
        const path = getLearningLogPath()
        const dir = dirname(path)
        if (ensuredDir !== dir) {
          ensuredDir = dir
          try {
            mkdirSync(dir, { recursive: true })
          } catch {
            // 目录已存在或不可写
          }
        }
        try {
          appendFileSync(path, content)
        } catch {
          // 写失败不影响主流程
        }
        updateLatestSymlink(dir, path)
      },
      flushIntervalMs: FLUSH_INTERVAL_MS,
      maxBufferSize: MAX_BUFFER_SIZE,
    })
    registerCleanup(async () => {
      writer?.flush()
    })
  }
  return writer
}

/**
 * 记录一行 learning 链路日志。
 *
 * stage 约定为 `cli.*` / `main.*` / `repl.*` / `query.*` / `api.*` 五段，
 * 按链路顺序排列即可还原一次请求的完整路径。
 */
export function learningLog(
  stage: string,
  fields?: Record<string, unknown>,
): void {
  if (!isLearningLogEnabled()) {
    return
  }
  let line = `${PREFIX} +${elapsedMs()}ms ${stage}`
  if (fields) {
    let rendered = ''
    for (const [key, value] of Object.entries(fields)) {
      const formatted = formatFieldValue(value)
      if (formatted !== undefined) {
        rendered += ` ${key}=${formatted}`
      }
    }
    line += rendered
  }
  getWriter().write(`${line}\n`)
}

/** 把缓冲立即落盘（进程退出前 / 排障用） */
export function flushLearningLog(): void {
  writer?.flush()
}
