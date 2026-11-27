import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'

import UnifiedSidebar from './UnifiedSidebar'

vi.mock(import('react-i18next'), async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (key: string) => key })
}))
vi.mock('@renderer/context/SidebarSlotProvider', () => ({ useSidebarShell: () => ({ setBodySlot: () => {} }) }))
vi.mock('@renderer/hooks/agents/useAllSessions', () => ({ useAllSessions: () => ({ sessions: [] }) }))
vi.mock('@renderer/hooks/useRuntime', () => ({ modelGenerating: vi.fn() }))
vi.mock('@renderer/hooks/useSettings', () => ({ useEnableDeveloperMode: () => ({ enableDeveloperMode: false }) }))
vi.mock('@renderer/services/DshPreviewService', () => ({ useDshPreviewStatus: () => undefined }))
vi.mock('@renderer/store', () => ({
  default: { getState: () => ({ runtime: { generating: false } }) },
  useAppDispatch: () => vi.fn(),
  useAppSelector: (select: (state: unknown) => unknown) => select({ messages: { loadingByTopic: {} } })
}))
vi.mock('@renderer/store/assistants', () => ({ selectAllTopics: () => [] }))
vi.mock('@renderer/store/runtime', () => ({ setActiveAgentId: vi.fn(), setActiveSessionIdAction: vi.fn() }))

afterEach(() => {
  localStorage.removeItem('zen-ui:toolbox')
})

it.each(['/', '/translate'])('starts with More tools collapsed at %s and toggles when clicked', (path) => {
  localStorage.setItem('zen-ui:toolbox', 'expanded')
  render(
    <MemoryRouter initialEntries={[path]}>
      <UnifiedSidebar />
    </MemoryRouter>
  )

  const toggle = screen.getByRole('button', { name: 'app_shell.more_tools' })
  const getTranslateLink = () => screen.queryByRole('link', { name: 'translate.title' })
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(getTranslateLink()).not.toBeInTheDocument()

  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(getTranslateLink()).toBeVisible()

  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(getTranslateLink()).not.toBeInTheDocument()
})
