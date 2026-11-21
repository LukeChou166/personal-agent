/**
 * Lossless context mode — effective setting resolution.
 *
 * Precedence (FR-001): session command > env > project-local > project > user
 * > managed/flag > default (off). Out-of-range values are clamped to the schema
 * limits and flagged so `/lossless status` can surface it.
 */

import { join } from 'path'
import { getClaudeConfigHomeDir, isEnvTruthy } from '../../utils/envUtils.js'
import {
  getInitialSettings,
  getSettingsWithSources,
} from '../../utils/settings/settings.js'
import type { SettingSource } from '../../utils/settings/constants.js'

export type LosslessSource =
  | 'session'
  | 'env'
  | 'local'
  | 'project'
  | 'user'
  | 'flag'
  | 'policy'
  | 'default'

export type LosslessConfig = {
  enabled: boolean
  source: LosslessSource
  storeRoot: string
  freshTailCount: number
  contextThreshold: number
  leafChunkTokens: number
  leafMinFanout: number
  leafTargetTokens: number
  condensedMinFanout: number
  condensedTargetTokens: number
  incrementalMaxDepth: number
  largeFileTokenThreshold: number
  maxExpandTokens: number
  summaryModel: string | undefined
  summaryTimeoutMs: number
  summaryCallWindowMs: number
  summaryMaxCallsPerWindow: number
  summarySpendBackoffMs: number
  ignoreSessionPatterns: string[]
  statelessSessionPatterns: string[]
  /** True when one or more values were outside the supported range. */
  clamped: boolean
}

type NumericKey = keyof Omit<
  LosslessConfig,
  | 'enabled'
  | 'source'
  | 'storeRoot'
  | 'summaryModel'
  | 'ignoreSessionPatterns'
  | 'statelessSessionPatterns'
  | 'clamped'
>

// [key, fallback, min, max, integer?] — env var is derived from the key.
type NumericSpec = readonly [
  key: NumericKey,
  fallback: number,
  min: number,
  max: number,
  integer?: boolean,
]

const NUMERIC_SPECS: readonly NumericSpec[] = [
  ['freshTailCount', 64, 1, 1000],
  ['contextThreshold', 0.75, 0.1, 0.99, false],
  ['leafChunkTokens', 20_000, 1000, 10_000_000],
  ['leafMinFanout', 8, 2, 1000],
  ['leafTargetTokens', 2400, 200, 100_000],
  ['condensedMinFanout', 4, 2, 1000],
  ['condensedTargetTokens', 2000, 200, 100_000],
  ['incrementalMaxDepth', 1, -1, 10],
  ['largeFileTokenThreshold', 25_000, 1000, 10_000_000],
  ['maxExpandTokens', 4000, 200, 8000],
  ['summaryTimeoutMs', 60_000, 1000, 3_600_000],
  ['summaryCallWindowMs', 600_000, 1000, 86_400_000],
  ['summaryMaxCallsPerWindow', 24, 0, 10_000],
  ['summarySpendBackoffMs', 1_800_000, 0, 86_400_000],
]

function envNameFor(key: string): string {
  return `LOSSLESS_${key.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`
}

const SOURCE_MAP: Record<SettingSource, LosslessSource> = {
  userSettings: 'user',
  projectSettings: 'project',
  localSettings: 'local',
  flagSettings: 'flag',
  policySettings: 'policy',
}

let sessionOverride: boolean | undefined
let cached: LosslessConfig | undefined

function resolveEnabled(): { enabled: boolean; source: LosslessSource } {
  if (sessionOverride !== undefined) {
    return { enabled: sessionOverride, source: 'session' }
  }

  const envValue = process.env.CLAUDE_CODE_LOSSLESS
  if (envValue !== undefined && envValue.trim() !== '') {
    return { enabled: isEnvTruthy(envValue), source: 'env' }
  }

  const { sources } = getSettingsWithSources()
  for (let i = sources.length - 1; i >= 0; i--) {
    const entry = sources[i]
    if (!entry) continue
    const value = entry.settings.lossless?.enabled
    if (typeof value === 'boolean') {
      return { enabled: value, source: SOURCE_MAP[entry.source] ?? 'default' }
    }
  }

  return { enabled: false, source: 'default' }
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

function clampNumber(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
  integer: boolean,
): { value: number; clamped: boolean } {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { value: fallback, clamped: false }
  }
  const normalized = integer ? Math.round(raw) : raw
  if (normalized < min) return { value: min, clamped: true }
  if (normalized > max) return { value: max, clamped: true }
  return { value: normalized, clamped: false }
}

function buildConfig(): LosslessConfig {
  const settings = getInitialSettings().lossless ?? {}
  const raw = settings as Record<string, unknown>
  const numeric = {} as Record<NumericKey, number>
  let clamped = false

  for (const [key, fallback, min, max, integer] of NUMERIC_SPECS) {
    const result = clampNumber(
      envNumber(envNameFor(key)) ?? raw[key],
      fallback,
      min,
      max,
      integer ?? true,
    )
    clamped ||= result.clamped
    numeric[key] = result.value
  }

  const resolved = resolveEnabled()
  const storeRoot =
    process.env.LOSSLESS_DATABASE_PATH?.trim() ||
    join(getClaudeConfigHomeDir(), 'lossless')
  const summaryModel =
    process.env.LOSSLESS_SUMMARY_MODEL?.trim() || settings.summaryModel

  return {
    enabled: resolved.enabled,
    source: resolved.source,
    storeRoot,
    ...numeric,
    summaryModel,
    ignoreSessionPatterns: settings.ignoreSessionPatterns ?? [],
    statelessSessionPatterns: settings.statelessSessionPatterns ?? [],
    clamped,
  }
}

/** Effective config snapshot for the current process (cached until override). */
export function getLosslessConfig(): LosslessConfig {
  cached ??= buildConfig()
  return cached
}

export function isLosslessEnabled(): boolean {
  return getLosslessConfig().enabled
}

/** `/lossless on|off` — applies from the next turn, not the current one. */
export function setSessionOverride(enabled: boolean): void {
  sessionOverride = enabled
  cached = undefined
}

/** Test helper: drop cached state so env/settings changes are re-read. */
export function resetLosslessConfigCacheForTesting(): void {
  sessionOverride = undefined
  cached = undefined
}
