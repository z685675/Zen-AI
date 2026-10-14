import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { InstalledSkill, SkillCompatibilityReport } from '@types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))
import SkillCompatibility from '../SkillCompatibility'

const inspect = vi.fn()
const skill = { id: 'first', isEnabled: true } as InstalledSkill
const report: SkillCompatibilityReport = {
  name: 'sample',
  enabled: true,
  definitionValid: true,
  compatibility: null,
  declaredTools: [],
  requiredCommands: [],
  missingCommands: [],
  alternativeCommands: [],
  alternativesAvailable: null,
  requiredEnvironment: [],
  missingEnvironment: [],
  conflicts: [{ name: 'sample', source: 'builtin', folder: 'sample' }],
  warnings: []
}
beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  }))
  inspect.mockReset()
  Object.assign(window.api, { skill: { inspect } })
  inspect.mockResolvedValue({ success: true, data: report })
})
afterEach(cleanup)

describe('Skill compatibility UI', () => {
  it('only inspects after a user click and shows status/limits/conflicts', async () => {
    render(<SkillCompatibility skill={skill} />)
    expect(inspect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'assistantProduct.inspectSkill' }))
    await waitFor(() => expect(screen.getByText('assistantProduct.enabledHint')).toBeVisible())
    expect(inspect).toHaveBeenCalledWith('first')
    expect(screen.getByText('assistantProduct.skillLimit')).toBeVisible()
    expect(screen.getByText('assistantProduct.conflictHint')).toBeVisible()
  })
  it('reports a check failure without claiming skill success', async () => {
    inspect.mockRejectedValue(new Error('failure'))
    render(<SkillCompatibility skill={skill} />)
    fireEvent.click(screen.getByRole('button', { name: 'assistantProduct.inspectSkill' }))
    await waitFor(() => expect(screen.getByText('assistantProduct.inspectFailed')).toBeVisible())
    expect(screen.queryByText('assistantProduct.definitionValid')).not.toBeInTheDocument()
  })
  it('discards a stale reply after selection changes', async () => {
    let resolve: (value: any) => void = () => undefined
    inspect.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const view = render(<SkillCompatibility skill={skill} />)
    fireEvent.click(screen.getByRole('button', { name: 'assistantProduct.inspectSkill' }))
    view.rerender(<SkillCompatibility skill={{ ...skill, id: 'other' }} />)
    resolve({ success: true, data: report })
    await waitFor(() => expect(screen.queryByText('assistantProduct.enabledHint')).not.toBeInTheDocument())
  })
})
