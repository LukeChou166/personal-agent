import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { SettingSource } from 'src/utils/settings/constants.js'
import type { SettingsJson } from 'src/utils/settings/types.js'

type Sources = Array<{ source: SettingSource; settings: SettingsJson }>

let mergedSettings: SettingsJson = {}
let settingsSources: Sources = []

// mock 设置模块，避免把 bootstrap 与文件系统副作用带进本套测试。
mock.module('src/utils/settings/settings.js', () => ({
  getInitialSettings: () => mergedSettings,
  getSettingsWithSources: () => ({
    effective: mergedSettings,
    sources: settingsSources,
  }),
  updateSettingsForSource: () => ({ error: null }),
}))

const {
  getLosslessConfig,
  isLosslessEnabled,
  resetLosslessConfigCacheForTesting,
  setSessionOverride,
} = await import('src/services/lossless/index.js')

afterAll(() => mock.restore())

beforeEach(() => {
  mergedSettings = {}
  settingsSources = []
  for (const key of [
    'CLAUDE_CODE_LOSSLESS',
    'LOSSLESS_DATABASE_PATH',
    'LOSSLESS_CONTEXT_THRESHOLD',
  ]) {
    delete process.env[key]
  }
  resetLosslessConfigCacheForTesting()
})

describe('lossless settings resolution', () => {
  test('defaults to off with documented defaults', () => {
    const config = getLosslessConfig()
    expect(config.enabled).toBe(false)
    expect(config.source).toBe('default')
    expect(config.freshTailCount).toBe(64)
    expect(config.contextThreshold).toBe(0.75)
    expect(config.summaryMaxCallsPerWindow).toBe(24)
    expect(config.storeRoot.endsWith('lossless')).toBe(true)
  })

  test('environment overrides settings and reports its source', () => {
    settingsSources = [
      { source: 'userSettings', settings: { lossless: { enabled: false } } },
    ]
    process.env.CLAUDE_CODE_LOSSLESS = '1'
    expect(isLosslessEnabled()).toBe(true)
    expect(getLosslessConfig().source).toBe('env')

    process.env.CLAUDE_CODE_LOSSLESS = '0'
    resetLosslessConfigCacheForTesting()
    expect(isLosslessEnabled()).toBe(false)
  })

  test('project-local overrides project, and settings source is reported', () => {
    settingsSources = [
      { source: 'userSettings', settings: { lossless: { enabled: true } } },
      { source: 'projectSettings', settings: { lossless: { enabled: false } } },
      { source: 'localSettings', settings: { lossless: { enabled: true } } },
    ]
    expect(isLosslessEnabled()).toBe(true)
    expect(getLosslessConfig().source).toBe('local')
  })

  test('session override beats environment', () => {
    process.env.CLAUDE_CODE_LOSSLESS = '1'
    setSessionOverride(false)
    expect(isLosslessEnabled()).toBe(false)
    expect(getLosslessConfig().source).toBe('session')
  })

  test('out-of-range values are clamped and flagged', () => {
    mergedSettings = {
      lossless: { enabled: true, contextThreshold: 5, freshTailCount: 0 },
    }
    const config = getLosslessConfig()
    expect(config.contextThreshold).toBe(0.99)
    expect(config.freshTailCount).toBe(1)
    expect(config.clamped).toBe(true)
  })
})
