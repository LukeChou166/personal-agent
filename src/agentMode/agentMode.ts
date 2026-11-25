import {
  isBuiltInAgent,
  type AgentDefinition,
} from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import type { Tool, Tools } from '../Tool.js'
import { toolMatchesName } from '../Tool.js'

/**
 * Agent Mode Manager
 *
 * Manages the currently active agent for the main session.
 * This allows users to switch between different agent configurations
 * (system prompts, tool sets) mid-session, similar to a "todo list mode"
 * where each agent represents a different work context.
 */

// Global state for the current active agent
let currentAgentDefinition: AgentDefinition | null = null

/**
 * Get the currently active agent definition
 * @returns The active agent definition, or null if no agent is active
 */
export function getCurrentAgentDefinition(): AgentDefinition | null {
  return currentAgentDefinition
}

/**
 * Set the currently active agent definition
 * @param agent The agent definition to activate, or null to deactivate
 */
export function setCurrentAgentDefinition(agent: AgentDefinition | null): void {
  currentAgentDefinition = agent
}

/**
 * Check if an agent is currently active
 * @returns True if an agent is active
 */
export function isAgentActive(): boolean {
  return currentAgentDefinition !== null
}

/**
 * Get the active agent's name
 * @returns The agent type name, or null if no agent is active
 */
export function getActiveAgentName(): string | null {
  return currentAgentDefinition?.agentType ?? null
}

/**
 * Get the active agent's allowed tools list
 * @returns Array of tool names, or undefined if all tools are allowed
 */
export function getActiveAgentTools(): string[] | undefined {
  return currentAgentDefinition?.tools
}

/**
 * Get the active agent's disallowed tools list
 * @returns Array of disallowed tool names, or undefined
 */
export function getActiveAgentDisallowedTools(): string[] | undefined {
  return currentAgentDefinition?.disallowedTools
}

/**
 * Get the active agent's system prompt
 * @returns The system prompt string, or null if no agent is active
 */
export function getActiveAgentSystemPrompt(): string | null {
  if (!currentAgentDefinition) {
    return null
  }
  // 内置 agent 的 prompt 需要 toolUseContext 才能生成，这里（主线程 agent
  // 模式）没有可传的 tool-use context，所以直接返回 null。
  if (isBuiltInAgent(currentAgentDefinition)) {
    return null
  }
  return currentAgentDefinition.getSystemPrompt()
}

/**
 * Filter tools based on the active agent's tool restrictions
 * @param tools The tools to filter
 * @returns Filtered tools array based on agent's tools/disallowedTools
 */
export function filterToolsForActiveAgent(tools: Tools): Tools {
  if (!currentAgentDefinition) {
    return tools
  }

  const { tools: allowedTools, disallowedTools } = currentAgentDefinition

  // If no tool restrictions, return all tools
  if (!allowedTools && !disallowedTools) {
    return tools
  }

  let filteredTools = tools

  // Filter by allowed tools list
  if (allowedTools && allowedTools.length > 0) {
    // Check if it's a wildcard (all tools allowed)
    if (allowedTools.length === 1 && allowedTools[0] === '*') {
      // All tools allowed, no filtering needed
    } else {
      // Only keep tools that are in the allowed list
      filteredTools = filteredTools.filter(tool =>
        allowedTools.some(allowed => toolMatchesName(tool, allowed)),
      )
    }
  }

  // Filter out disallowed tools
  if (disallowedTools && disallowedTools.length > 0) {
    filteredTools = filteredTools.filter(
      tool =>
        !disallowedTools.some(disallowed => toolMatchesName(tool, disallowed)),
    )
  }

  return filteredTools
}
