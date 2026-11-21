import type { Command } from '../../commands.js'

const lossless = {
  type: 'local',
  name: 'lossless',
  description:
    'Inspect or toggle lossless context mode — keep every message locally, summarise in layers',
  supportsNonInteractive: true,
  argumentHint: 'on|off|status|doctor [--save]',
  load: () => import('./lossless.js'),
} satisfies Command

export default lossless
