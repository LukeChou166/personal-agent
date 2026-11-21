/**
 * 无损模式的本地存储层。
 *
 * 每个会话一个目录，内置三个文件：
 * - `messages.jsonl`：追加写，一行一条消息记录；
 * - `nodes.jsonl`：追加写，一行一个摘要节点；
 * - `meta.json`：原子替换写，保存计数与最后写入位置。
 *
 * 追加写在崩溃时最多丢最后一行；读取时坏行跳过并计数，不阻断对话。
 * 存储根目录由设置提供，始终位于用户配置目录，不写仓库工作区。
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export const STORE_SCHEMA_VERSION = 1

export type MessageRecord = {
  v: 1
  seq: number
  uuid: string
  ts: string
  role: string
  blocks: Record<string, unknown>[]
  toolUseId?: string
  toolName?: string
  tokenEstimate: number
  large: boolean
  summaryOf?: string
  sourceRef?: string
}

export type SummaryNode = {
  v: 1
  id: string
  sessionId: string
  depth: number
  kind: 'leaf' | 'condensed'
  childNodeIds: string[]
  span: { firstSeq: number; lastSeq: number }
  messageIds?: string[]
  text: string
  tokenEstimate: number
  model: string
  createdAt: string
  status: 'active' | 'corrupt'
}

export type StoreMeta = {
  schemaVersion: number
  sessionId: string
  projectKey: string
  createdAt: string
  updatedAt: string
  lastSeq: number
  lastUuid?: string
  messageCount: number
  nodeCount: number
  corruptLines: number
}

export type StorePaths = {
  dir: string
  messages: string
  nodes: string
  meta: string
}

export type LosslessStore = {
  paths: StorePaths
  ensure(): void
  appendMessage(record: MessageRecord): void
  appendNode(node: SummaryNode): void
  readMessages(): { records: MessageRecord[]; corruptLines: number }
  readNodes(): { nodes: SummaryNode[]; corruptLines: number }
  readMeta(): StoreMeta | null
  writeMeta(meta: StoreMeta): void
  knownUuids(): Set<string>
  nextSeq(): number
}

export function getStorePaths(
  storeRoot: string,
  projectKey: string,
  sessionId: string,
): StorePaths {
  const dir = join(storeRoot, projectKey, sessionId)
  return {
    dir,
    messages: join(dir, 'messages.jsonl'),
    nodes: join(dir, 'nodes.jsonl'),
    meta: join(dir, 'meta.json'),
  }
}

function parseLines<T>(content: string): { items: T[]; corrupt: number } {
  const items: T[] = []
  let corrupt = 0
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      items.push(JSON.parse(line) as T)
    } catch {
      corrupt++
    }
  }
  return { items, corrupt }
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

export function createStore(options: {
  storeRoot: string
  projectKey: string
  sessionId: string
}): LosslessStore {
  const paths = getStorePaths(
    options.storeRoot,
    options.projectKey,
    options.sessionId,
  )

  const ensure = (): void => {
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
    for (const file of [paths.messages, paths.nodes]) {
      if (!existsSync(file)) writeFileSync(file, '', { mode: 0o600 })
    }
    // umask 可能放宽权限，这里显式收紧（Windows 上 chmod 语义不同，忽略失败）。
    try {
      chmodSync(paths.dir, 0o700)
      chmodSync(paths.messages, 0o600)
      chmodSync(paths.nodes, 0o600)
    } catch {
      // 非 POSIX 平台忽略即可，不阻断记录
    }
  }

  const appendLine = (file: string, value: unknown): void => {
    ensure()
    appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  }

  const readMeta = (): StoreMeta | null => {
    const raw = readText(paths.meta)
    if (!raw.trim()) return null
    try {
      return JSON.parse(raw) as StoreMeta
    } catch {
      return null
    }
  }

  const writeMeta = (meta: StoreMeta): void => {
    ensure()
    const tmp = `${paths.meta}.tmp`
    writeFileSync(tmp, JSON.stringify(meta, null, 2), { mode: 0o600 })
    renameSync(tmp, paths.meta)
  }

  return {
    paths,
    ensure,
    appendMessage(record) {
      appendLine(paths.messages, record)
    },
    appendNode(node) {
      appendLine(paths.nodes, node)
    },
    readMessages() {
      const { items, corrupt } = parseLines<MessageRecord>(
        readText(paths.messages),
      )
      return { records: items, corruptLines: corrupt }
    },
    readNodes() {
      const { items, corrupt } = parseLines<SummaryNode>(readText(paths.nodes))
      return { nodes: items, corruptLines: corrupt }
    },
    readMeta,
    writeMeta,
    knownUuids() {
      const { records } = this.readMessages()
      return new Set(records.map(record => record.uuid))
    },
    nextSeq() {
      return (readMeta()?.lastSeq ?? 0) + 1
    },
  }
}
