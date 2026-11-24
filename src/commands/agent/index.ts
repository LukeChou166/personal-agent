import type { Command } from '../../commands.js'

const agent = {
  type: 'local',
  name: 'agent',
  description: 'Switch to a specific agent mode or list available agents',
  supportsNonInteractive: false,
  load: () => import('./agent.js'),
} satisfies Command

export default agent
