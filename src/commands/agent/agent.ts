import type { LocalCommandCall } from '../../types/command.js'
import { setCurrentAgentDefinition } from '../../agentMode/agentMode.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { getCwd } from '../../utils/cwd.js'
import { getAgentDefinitionsWithOverrides } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'

export const call: LocalCommandCall = async (args, context) => {
  const trimmedArgs = args.trim()

  // No args: show help
  if (!trimmedArgs) {
    const cwd = getCwd()
    const { activeAgents } = await getAgentDefinitionsWithOverrides(cwd)

    if (activeAgents.length === 0) {
      return {
        type: 'text',
        value:
          'No agents available. Create agents in .claude/agents/ directory.',
      }
    }

    const agentList = activeAgents
      .map(a => `  - ${a.agentType}: ${a.whenToUse}`)
      .join('\n')

    return {
      type: 'text',
      value: `Available agents:\n${agentList}\n\nUsage: /agent <name> to switch, /agent off to exit agent mode`,
    }
  }

  // Exit agent mode
  if (
    trimmedArgs === 'off' ||
    trimmedArgs === 'exit' ||
    trimmedArgs === 'none'
  ) {
    setCurrentAgentDefinition(null)
    clearSystemPromptSections()

    return {
      type: 'text',
      value: 'Exited agent mode. Using default configuration.',
    }
  }

  // Switch to specified agent
  const agentName = trimmedArgs
  const cwd = getCwd()
  const { activeAgents } = await getAgentDefinitionsWithOverrides(cwd)

  const agentDefinition = activeAgents.find(a => a.agentType === agentName)

  if (!agentDefinition) {
    const availableAgents = activeAgents.map(a => a.agentType).join(', ')
    return {
      type: 'text',
      value: `Agent "${agentName}" not found. Available agents: ${availableAgents}`,
    }
  }

  // Set the agent and clear system prompt cache so it gets regenerated
  setCurrentAgentDefinition(agentDefinition)
  clearSystemPromptSections()

  const toolsInfo = agentDefinition.tools
    ? ` (tools: ${agentDefinition.tools.join(', ')})`
    : ' (all tools)'

  return {
    type: 'text',
    value: `Switched to agent: ${agentDefinition.agentType}${toolsInfo}\nDescription: ${agentDefinition.whenToUse}`,
  }
}
