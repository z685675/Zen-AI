import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import PaintingsRoutePage from '../PaintingsRoutePage'

const mocks = vi.hoisted(() => ({
  providers: [],
  open: vi.fn(),
  sync: vi.fn(),
  resize: vi.fn(),
  visible: vi.fn(),
  close: vi.fn(),
  importLegacy: vi.fn(),
  appearance: vi.fn(),
  preset: 'codex',
  theme: 'light',
  paintings: {},
  top: false
}))
vi.mock('@renderer/hooks/useProvider', () => ({ useProviders: () => ({ providers: mocks.providers }) }))
vi.mock('../imageCanvasProviders', () => ({ imageCanvasProviders: () => [] }))
vi.mock('@renderer/store', () => ({
  useAppSelector: (select: (state: unknown) => unknown) =>
    select({ paintings: mocks.paintings, settings: { userTheme: { userFontFamily: '' } } })
}))
vi.mock('@renderer/services/FileManager', () => ({
  default: { getStorageFileName: (file: { name: string }) => file.name }
}))
vi.mock('@renderer/context/ThemeProvider', () => ({ useTheme: () => ({ theme: mocks.theme, preset: mocks.preset }) }))
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
vi.mock('antd', () => ({
  Spin: () => <span>opening</span>,
  Button: ({ children, onClick }: any) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  )
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.top = false
  mocks.paintings = {}
  mocks.preset = 'codex'
  mocks.theme = 'light'
  for (const fn of [mocks.sync, mocks.resize, mocks.visible, mocks.close, mocks.appearance])
    fn.mockResolvedValue(undefined)
  mocks.open.mockResolvedValue({ ok: true })
  mocks.importLegacy.mockResolvedValue(0)
  window.api = {
    imageCanvas: {
      open: mocks.open,
      sync: mocks.sync,
      setAppearance: mocks.appearance,
      resize: mocks.resize,
      setVisible: mocks.visible,
      close: mocks.close,
      importLegacy: mocks.importLegacy
    }
  } as any
})
afterEach(cleanup)

describe('image and video page shell', () => {
  it('switches the existing native view to the selected theme without reopening it', async () => {
    const page = render(<PaintingsRoutePage />)
    await waitFor(() => expect(mocks.visible).toHaveBeenLastCalledWith(true))
    mocks.preset = 'zen-paper'
    mocks.theme = 'dark'
    page.rerender(<PaintingsRoutePage />)
    await waitFor(() =>
      expect(mocks.appearance).toHaveBeenLastCalledWith(
        expect.objectContaining({
          theme: 'dark',
          themePreset: 'zen-paper'
        })
      )
    )
    expect(mocks.open).toHaveBeenCalledOnce()
    expect(mocks.close).not.toHaveBeenCalled()
  })
  it('keeps the draggable application navbar and delegates both tabs to a single native view', async () => {
    const page = render(<PaintingsRoutePage />)
    expect(screen.getByRole('button', { name: 'minimize' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'maximize' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'close' })).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    await waitFor(() => expect(mocks.visible).toHaveBeenLastCalledWith(true))
    expect(mocks.open).toHaveBeenCalledOnce()
    page.unmount()
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('imports completed legacy results once per ID, with only their prompts and asset locations', async () => {
    const completed = {
      id: 'legacy',
      prompt: 'original prompt',
      model: 'old model',
      files: [{ name: 'result.png', created_at: '2026-01-01T01:00:00Z' }],
      urls: []
    }
    mocks.paintings = {
      openai_image_generate: [completed],
      siliconflow_paintings: [completed, { id: 'draft', prompt: 'unsent', files: [], urls: [] }]
    }
    render(<PaintingsRoutePage />)
    await waitFor(() =>
      expect(mocks.importLegacy).toHaveBeenCalledWith([
        {
          id: 'legacy',
          prompt: 'original prompt',
          createdAt: '2026-01-01T01:00:00Z',
          assets: [{ name: 'result.png', url: undefined }]
        }
      ])
    )
  })

  it('does not duplicate window controls when the top navigation already owns them', async () => {
    mocks.top = true
    render(<PaintingsRoutePage />)
    expect(screen.queryByRole('button', { name: 'minimize' })).not.toBeInTheDocument()
    await waitFor(() => expect(mocks.open).toHaveBeenCalledOnce())
  })
})
