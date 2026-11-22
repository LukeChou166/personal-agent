/**
 * 只读诊断：检查消息/摘要的一致性，不修改任何数据、不发起模型调用。
 *
 * 发现的损坏只报告，修复能力不在本期范围内。
 */

import { getSessionStore } from './sessionStore.js'

export type DiagnosticsReport = {
  messages: number
  nodes: number
  corruptLines: number
  badChildren: string[]
  uncoveredMessages: number
}

export function diagnoseCurrentSession(): DiagnosticsReport {
  const { store } = getSessionStore()
  const { records, corruptLines: messageCorruption } = store.readMessages()
  const { nodes, corruptLines: nodeCorruption } = store.readNodes()

  const ids = new Set(nodes.map(node => node.id))
  const badChildren = nodes
    .filter(node => node.childNodeIds.some(child => !ids.has(child)))
    .map(node => node.id)

  const spans = nodes.map(node => node.span)
  const uncoveredMessages = records.filter(
    record =>
      !spans.some(
        span => record.seq >= span.firstSeq && record.seq <= span.lastSeq,
      ),
  ).length

  return {
    messages: records.length,
    nodes: nodes.length,
    corruptLines: messageCorruption + nodeCorruption,
    badChildren,
    uncoveredMessages,
  }
}
