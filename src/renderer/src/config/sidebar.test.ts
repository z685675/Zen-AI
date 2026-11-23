import { describe, expect, it } from 'vitest'

import { ALL_SIDEBAR_ICONS, DEFAULT_SIDEBAR_ICONS, getAvailableSidebarIcons } from './sidebar'

describe('assistant sidebar placement', () => {
  it('places the assistant after AI chat and omits the old entry', () => {
    expect(DEFAULT_SIDEBAR_ICONS).toEqual([
      'assistants',
      'new_assistant',
      'translate',
      'notes',
      'files',
      'paintings',
      'usage',
      'model_status'
    ])
    expect(ALL_SIDEBAR_ICONS).not.toContain('agents')
  })

  it('upgrades existing layouts without resetting the order of other entries', () => {
    expect(getAvailableSidebarIcons(['files', 'agents', 'assistants', 'paintings', 'new_assistant', 'notes'])).toEqual([
      'files',
      'assistants',
      'new_assistant',
      'paintings',
      'notes',
      'usage',
      'model_status'
    ])
  })

  it('adds the new entry to old layouts, but respects explicitly hidden entries', () => {
    expect(getAvailableSidebarIcons(['assistants', 'agents', 'paintings'])).toEqual([
      'assistants',
      'new_assistant',
      'paintings',
      'usage',
      'model_status'
    ])
    expect(getAvailableSidebarIcons(['assistants', 'agents', 'paintings'], ['new_assistant', 'agents'])).toEqual([
      'assistants',
      'paintings',
      'usage',
      'model_status'
    ])
  })

  it('is idempotent, removes duplicates and ignores obsolete entries', () => {
    const icons = getAvailableSidebarIcons(['assistants', 'agents', 'agents', 'research', 'new_assistant'] as any)
    expect(icons).toEqual(['assistants', 'new_assistant', 'usage', 'model_status'])
    expect(getAvailableSidebarIcons(icons)).toEqual(icons)
    expect(getAvailableSidebarIcons(icons, [], true)).toEqual(icons)
  })
  it('respects a hidden usage entry and preserves its placement when restoring it', () => {
    expect(getAvailableSidebarIcons(['assistants', 'usage', 'agents'], ['usage'])).toEqual([
      'assistants',
      'new_assistant',
      'model_status'
    ])
    expect(getAvailableSidebarIcons(['usage', 'assistants', 'agents'])).toEqual([
      'assistants',
      'new_assistant',
      'usage',
      'model_status'
    ])
  })
})
