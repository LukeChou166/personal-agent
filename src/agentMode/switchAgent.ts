import { getAgentDefinitionsWithOverrides } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { clearSystemPromptSections } from '../constants/systemPromptSections.js'
import { getCwd } from '../utils/cwd.js'
import { setCurrentAgentDefinition } from './agentMode.js'

/**
 * 切换结果：text 分支可直接作为 slash 命令的返回值透传。
 */
export type AgentSwitchResult = { type: 'text'; value: string }

/**
 * 把当前主线程切换到指定 agent（按 agentType 精确匹配）。
 *
 * 这是「每个 agent 一条 slash 命令」的底层实现：`/hello-agent` 触发后，
 * 命令会以 hello-agent 作为参数调用本函数，等效于旧的 `/agent hello-agent`。
 *
 * 做的事情：
 * 1. 从 .claude/agents/ 重新加载 agent 列表，精确匹配名字；
 * 2. setCurrentAgentDefinition 写入 agentMode 全局状态；
 * 3. clearSystemPromptSections 清掉 system prompt 缓存，让下一次 query
 *    用新 agent 的 system prompt 与工具白名单重新生成。
 */
export async function switchToAgent(
  agentName: string,
): Promise<AgentSwitchResult> {
  const cwd = getCwd()
  const { activeAgents } = await getAgentDefinitionsWithOverrides(cwd)

  const agentDefinition = activeAgents.find(a => a.agentType === agentName)
  if (!agentDefinition) {
    const availableAgents = activeAgents.map(a => a.agentType).join(', ')
    return {
      type: 'text',
      value: `未找到 agent「${agentName}」，可用：${availableAgents}`,
    }
  }

  // 写入全局状态并清缓存，让下一次 query 用新 agent 的 prompt 与工具
  setCurrentAgentDefinition(agentDefinition)
  clearSystemPromptSections()

  const toolsInfo = agentDefinition.tools
    ? `（工具：${agentDefinition.tools.join(', ')}）`
    : '（全部工具）'

  return {
    type: 'text',
    value: `已切换到 agent：${agentDefinition.agentType}${toolsInfo}\n描述：${agentDefinition.whenToUse}`,
  }
}
