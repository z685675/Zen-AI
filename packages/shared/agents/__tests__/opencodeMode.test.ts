import { describe, expect, it } from 'vitest'

import { getOpenCodeAgentMode } from '../opencodeMode'

describe('OpenCode mode compatibility', () => {
  it('keeps Plan read-only', () => {
    expect(getOpenCodeAgentMode('plan')).toBe('plan')
  })
  it.each([undefined, null, 'default', 'acceptEdits', 'bypassPermissions'])(
    'maps stored %s to native Build without a database rewrite',
    (value) => expect(getOpenCodeAgentMode(value)).toBe('build')
  )
})
