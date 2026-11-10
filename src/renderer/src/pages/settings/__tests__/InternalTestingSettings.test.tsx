import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  status: { unlocked: false, state: 'not-installed', version: 'test' } as any,
  navigate: vi.fn(),
  unlock: vi.fn(),
  prepare: vi.fn(),
  lock: vi.fn()
}))
vi.mock('@renderer/context/ThemeProvider', () => ({ useTheme: () => ({ theme: 'light' }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }))
vi.mock('@renderer/services/DshPreviewService', () => ({
  useDshPreviewStatus: () => mocks.status,
  publishDshPreviewStatus: (status: any) => {
    mocks.status = status
  },
  refreshDshPreviewStatus: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('../index', () => {
  const Block = ({ children }: any) => <div>{children}</div>
  return {
    SettingDescription: Block,
    SettingDivider: Block,
    SettingGroup: Block,
    SettingRow: Block,
    SettingRowTitle: Block,
    SettingTitle: Block
  }
})
import InternalTestingSettings from '../InternalTestingSettings'

describe('internal testing settings', () => {
  it('hides the entry before verification, shows download progress, and can close preparation without navigating', async () => {
    window.api = { ...window.api, internalTesting: { unlock: mocks.unlock, prepare: mocks.prepare, lock: mocks.lock } }
    mocks.unlock.mockResolvedValue({ accepted: false, status: mocks.status })
    const view = render(<InternalTestingSettings />)
    expect(screen.queryByText('settings.internalTesting.entry')).toBeNull()
    fireEvent.click(screen.getByText('settings.internalTesting.unlock'))
    const password = await screen.findByPlaceholderText('settings.internalTesting.password')
    fireEvent.change(password, { target: { value: 'wrong' } })
    fireEvent.keyDown(password, { key: 'Enter', code: 'Enter' })
    expect(await screen.findByText('settings.internalTesting.passwordIncorrect')).toBeTruthy()
    expect(mocks.prepare).not.toHaveBeenCalled()
    mocks.unlock.mockResolvedValue({ accepted: true, status: { ...mocks.status, unlocked: true } })
    fireEvent.change(password, { target: { value: '\u4e16\u754c\u548c\u5e73' } })
    fireEvent.keyDown(password, { key: 'Enter', code: 'Enter' })
    expect(await screen.findByText('settings.internalTesting.entry')).toBeTruthy()
    let finish!: (value: any) => void
    mocks.prepare.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    fireEvent.click(screen.getByText('settings.internalTesting.enter'))
    expect(await screen.findByText('settings.internalTesting.preparing')).toBeTruthy()
    mocks.lock.mockResolvedValue({ unlocked: false, state: 'not-installed', version: 'test' })
    fireEvent.click(screen.getByText('settings.internalTesting.lock'))
    await waitFor(() => expect(screen.queryByText('settings.internalTesting.entry')).toBeNull())
    finish({ unlocked: true, state: 'ready', version: 'test' })
    await waitFor(() => expect(mocks.lock).toHaveBeenCalledOnce())
    expect(mocks.navigate).not.toHaveBeenCalled()
    view.unmount()
  })
})
