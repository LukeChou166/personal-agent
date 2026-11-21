/**
 * `/lossless` — toggle and inspect lossless context mode.
 *
 * Batch 1 implements on/off/status/help plus the session-vs-persisted split.
 * `doctor` is a read-only diagnostic added in a later batch.
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
    : 'no records yet (store lands in the next batch)'

  return [
    `lossless: ${state} (source: ${config.source})${clamped}`,
    `  store: ${config.storeRoot}`,
    `  records: ${records}`,
    `  backlog: ${stats.pendingMessages} messages pending, ${stats.failures} failures`,
    `  guard: ${stats.callsInWindow}/${config.summaryMaxCallsPerWindow} calls in window, backoff policy: ${formatMs(config.summarySpendBackoffMs)}`,
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

    case 'doctor':
      return {
        type: 'text',
        value:
          'lossless doctor: read-only diagnostics are not available in this batch. Use /lossless status for the effective setting.',
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
