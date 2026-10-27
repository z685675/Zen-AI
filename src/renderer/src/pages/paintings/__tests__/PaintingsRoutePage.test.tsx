import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import PaintingsRoutePage from '../PaintingsRoutePage'

const mocks = vi.hoisted(() => ({
  providers: [],
  open: vi.fn(),
  sync: vi.fn(),
  resize: vi.fn(),
  visible: vi.fn(),
  close: vi.fn(),
  dispatch: vi.fn(),
  top: false
}))
vi.mock('@renderer/hooks/useProvider', () => ({
  useProviders: () => ({ providers: mocks.providers }),
  usePaintingProviders: () => mocks.providers
}))
vi.mock('@renderer/store', () => ({ useAppDispatch: () => mocks.dispatch, useAppSelector: () => '' }))
vi.mock('@renderer/store/settings', () => ({ setDefaultPaintingProvider: vi.fn() }))
vi.mock('@renderer/store/tabs', () => ({ updateTab: vi.fn() }))
vi.mock('@renderer/config/models', () => ({ isImageGenerationEndpointModel: () => true }))
vi.mock('@renderer/context/ThemeProvider', () => ({ useTheme: () => ({ theme: 'light' }) }))
vi.mock('@renderer/hooks/useFullscreen', () => ({ useFullscreen: () => false }))
vi.mock('@renderer/hooks/useNavBackgroundColor', () => ({ default: () => '#fff' }))
vi.mock('@renderer/hooks/useRuntime', () => ({ useRuntime: () => ({ minappShow: false }) }))
vi.mock('@renderer/hooks/useSettings', () => ({ useNavbarPosition: () => ({ isTopNavbar: mocks.top }) }))
vi.mock('@renderer/config/constant', () => ({ isMac: false, isWin: true, isLinux: false }))
vi.mock('@renderer/components/WindowControls', () => ({
  default: () => (
    <>
      <button type="button">minimize</button>
      <button type="button">maximize</button>
      <button type="button">close</button>
    </>
  )
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }) }))
vi.mock('react-router-dom', () => ({
  useParams: () => ({}),
  Routes: ({ children }: any) => <>{children}</>,
  Route: ({ index, element }: any) => (index ? null : element),
  Navigate: () => null
}))
vi.mock('antd', () => ({
  Select: ({ value, options, onChange, onOpenChange, ...props }: any) => (
    <select
      aria-label={props['aria-label']}
      value={value}
      onMouseDown={() => onOpenChange?.(true)}
      onChange={(event) => {
        onChange(event.target.value)
        onOpenChange?.(false)
      }}>
      {options.map((option: any) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
  Spin: () => <span>opening</span>,
  Button: ({ children, onClick }: any) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  )
}))
vi.mock('../NewApiPage', () => ({
  default: ({ showNavbar }: any) => <div>local-images{showNavbar !== false && <span>duplicate-navbar</span>}</div>
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.top = false
  for (const fn of [mocks.open, mocks.sync, mocks.resize, mocks.visible, mocks.close]) fn.mockResolvedValue(undefined)
  mocks.open.mockResolvedValue({ ok: true })
  window.api = {
    imageCanvas: {
      open: mocks.open,
      sync: mocks.sync,
      resize: mocks.resize,
      setVisible: mocks.visible,
      close: mocks.close
    },
    ovms: { getStatus: async () => 'not-running' }
  } as any
})
afterEach(cleanup)

describe('image page shell and mode switching', () => {
  it('retains the draggable application navbar and only exposes the two supported modes', async () => {
    render(<PaintingsRoutePage />)
    expect(screen.getByRole('button', { name: 'minimize' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'maximize' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'close' })).toBeInTheDocument()
    expect(screen.getAllByRole('option').map((item) => item.textContent)).toEqual([
      'image_studio.workbench',
      'image_studio.local'
    ])
    expect(screen.queryByText('model_setup.open_settings')).not.toBeInTheDocument()
    await waitFor(() => expect(mocks.open).toHaveBeenCalledOnce())
  })
  it('switches repeatedly without closing/reopening the native workbench or losing its draft', async () => {
    const page = render(<PaintingsRoutePage />)
    await waitFor(() => expect(mocks.visible).toHaveBeenLastCalledWith(true))
    const select = screen.getByRole('combobox')
    for (let i = 0; i < 5; i++) {
      fireEvent.change(select, { target: { value: 'local' } })
      expect(screen.getByText('local-images')).toBeInTheDocument()
      expect(mocks.visible).toHaveBeenLastCalledWith(false)
      expect(screen.queryByText('duplicate-navbar')).not.toBeInTheDocument()
      fireEvent.change(select, { target: { value: 'workbench' } })
      expect(screen.queryByText('local-images')).not.toBeInTheDocument()
      expect(mocks.visible).toHaveBeenLastCalledWith(true)
    }
    expect(mocks.open).toHaveBeenCalledOnce()
    expect(mocks.close).not.toHaveBeenCalled()
    page.unmount()
    expect(mocks.close).toHaveBeenCalledOnce()
  })
  it('hides the native view while selecting a mode and shows it again after selection', async () => {
    render(<PaintingsRoutePage />)
    await waitFor(() => expect(mocks.visible).toHaveBeenLastCalledWith(true))
    const select = screen.getByRole('combobox')
    fireEvent.mouseDown(select)
    expect(mocks.visible).toHaveBeenLastCalledWith(false)
    fireEvent.change(select, { target: { value: 'workbench' } })
    expect(mocks.visible).toHaveBeenLastCalledWith(true)
  })
  it('does not show a delayed native open above local images after switching during load', async () => {
    let finish!: (value: { ok: boolean }) => void
    mocks.open.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    render(<PaintingsRoutePage />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'local' } })
    await act(async () => finish({ ok: true }))
    expect(mocks.visible).toHaveBeenLastCalledWith(false)
    expect(mocks.close).not.toHaveBeenCalled()
  })
  it('does not duplicate global window controls when the top navigation already owns them', async () => {
    mocks.top = true
    render(<PaintingsRoutePage />)
    expect(screen.queryByRole('button', { name: 'minimize' })).not.toBeInTheDocument()
    await waitFor(() => expect(mocks.open).toHaveBeenCalledOnce())
  })
})
