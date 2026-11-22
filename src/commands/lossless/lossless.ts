/**
 * `/lossless` —— 开关与状态查看。
 *
 * 批次 1 实现 on/off/status/help，以及「会话内生效」与「持久化保存」的区分。
 * `doctor` 的只读诊断留到后续批次。
 */

import type { LocalCommandCall } from '../../types/command.js'
import {
  getLosslessConfig,
  getLosslessStats,
  setSessionOverride,
} from '../../services/lossless/index.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'

const HELP = [
  'Usage: /lossless [on|off|status|doctor] [--save]',
  '',
  '  status   show effective setting, store path and counters (default)',
  '  on       enable for this session only (takes effect next turn)',
  '  off      disable for this session only (takes effect next turn)',
  '  on|off --save  also persist to user settings',
  '  doctor   read-only consistency report (added in a later batch)',
].join('\n')

function formatMs(ms: number): string {
  if (ms <= 0) return 'none'
  const minutes = Math.round(ms / 60_000)
  return minutes >= 1 ? `${minutes}m` : `${Math.round(ms / 1000)}s`
}

function renderStatus(): string {
  const config = getLosslessConfig()
  const stats = getLosslessStats()
  const state = config.enabled ? 'ON' : 'OFF'
  const clamped = config.clamped ? ' (values clamped to supported range)' : ''
  const records = stats.recordsAvailable
    ? `${stats.messages} messages, ${stats.nodes} summary nodes`
    : 'no records yet for this session'

  const backoff = stats.backoffUntil
    ? `active until ${new Date(stats.backoffUntil).toISOString()}`
    : 'none'
  const tripped = stats.tripped ? ' (tripped: automatic summaries stopped)' : ''

  return [
    `lossless: ${state} (source: ${config.source})${clamped}`,
    `  store: ${config.storeRoot}`,
    `  records: ${records}`,
    `  backlog: ${stats.pendingMessages} messages / ${stats.pendingNodes} nodes pending, ${stats.failures} failures${tripped}`,
    `  guard: ${stats.callsInWindow}/${config.summaryMaxCallsPerWindow} calls in window, backoff: ${backoff}`,
    `  summary model: ${config.summaryModel ?? 'main loop model'} (${config.summaryModel ? 'override' : 'default'})`,
    config.enabled
      ? '  next: /lossless off to stop recording; existing records are kept'
      : '  next: /lossless on --save to enable for this project',
  ].join('\n')
}

function persistEnabled(enabled: boolean): string {
  const current = getInitialSettings().lossless ?? {}
  const { error } = updateSettingsForSource('userSettings', {
    lossless: { ...current, enabled },
  })
  return error
    ? ` (failed to save: ${error.message})`
    : ' and saved to user settings'
}

export const call: LocalCommandCall = async args => {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const subcommand = tokens[0] ?? 'status'
  const shouldSave = tokens.includes('--save')

  switch (subcommand) {
    case 'status':
      return { type: 'text', value: renderStatus() }

    case 'on':
    case 'off': {
      const enabled = subcommand === 'on'
      setSessionOverride(enabled)
      const saved = shouldSave ? persistEnabled(enabled) : ''
      return {
        type: 'text',
        value: `lossless: ${enabled ? 'ON' : 'OFF'} (source: session)${saved}\nTakes effect from the next turn; the current turn is not interrupted.`,
      }
    }

    case 'doctor': {
      try {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const { diagnoseCurrentSession } =
          require('../../services/lossless/diagnostics.js') as typeof import('../../services/lossless/diagnostics.js')
        /* eslint-enable @typescript-eslint/no-require-imports */
        const report = diagnoseCurrentSession()
        return {
          type: 'text',
          value: [
            'lossless doctor (read-only)',
            `  messages: ${report.messages}, nodes: ${report.nodes}, corrupt lines: ${report.corruptLines}`,
            `  uncovered messages: ${report.uncoveredMessages}`,
            `  nodes with missing children: ${report.badChildren.length}${report.badChildren.length ? ` (${report.badChildren.slice(0, 5).join(', ')})` : ''}`,
            '  next: no changes were made; repair is not available in this version',
          ].join('\n'),
        }
      } catch (error) {
        return {
          type: 'text',
          value: `lossless doctor failed: ${String(error)}`,
        }
      }
    }

    case 'help':
      return { type: 'text', value: HELP }

    default:
      return {
        type: 'text',
        value: `Unknown subcommand: ${subcommand}\n\n${HELP}`,
      }
  }
}
