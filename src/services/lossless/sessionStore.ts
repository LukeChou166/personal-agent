/**
 * 当前会话的存储句柄解析：设置 + 项目标识 + 会话标识。
 *
 * 单独成文件，避免 runtime（会引入压缩与 token 估算）被状态命令与工具
 * 连带引入，控制加载成本。
 */

import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'
import { getLosslessConfig, type LosslessConfig } from './settings.js'
import { createStore, type LosslessStore } from './store.js'

export type SessionStore = {
  store: LosslessStore
  config: LosslessConfig
  session: { sessionId: string; projectKey: string }
}

export function getSessionStore(): SessionStore {
  const config = getLosslessConfig()
  const sessionId = getSessionId()
  const projectKey = sanitizePath(getOriginalCwd())
  return {
    store: createStore({ storeRoot: config.storeRoot, projectKey, sessionId }),
    config,
    session: { sessionId, projectKey },
  }
}
