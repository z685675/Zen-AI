import { uiPaintingsSidebar, uiSidebar, uiThemePreset } from '@renderer/services/UiThemePresetService'
import { ThemeMode } from '@renderer/types'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider, useTheme } from '../ThemeProvider'

const mocks = vi.hoisted(() => ({
  theme: 'system',
  bootstrapped: false,
  setTheme: vi.fn(),
  persistEvents: new EventTarget()
}))

vi.mock('@renderer/config/constant', () => ({ isMac: false, isWin: true }))
vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => ({ theme: mocks.theme, language: 'en-US', setTheme: mocks.setTheme }),
  useNavbarPosition: () => ({ navbarPosition: 'left' })
}))
vi.mock('@renderer/hooks/useUserTheme', () => ({
  default: () => ({ initUserTheme: vi.fn() })
}))
vi.mock('@renderer/store', () => ({
  persistor: {
    getState: () => ({ bootstrapped: mocks.bootstrapped }),
    subscribe: (onChange: () => void) => {
      mocks.persistEvents.addEventListener('change', onChange)
      return () => mocks.persistEvents.removeEventListener('change', onChange)
    }
  }
}))

const ThemeProbe = () => {
  const { theme, toggleTheme } = useTheme()
  return (
    <button type="button" onClick={toggleTheme}>
      {theme}
    </button>
  )
}

describe('ThemeProvider', () => {
  const system = Object.assign(new EventTarget(), { matches: false })
  const nativeSetTheme = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    localStorage.clear()
    mocks.theme = ThemeMode.system
    mocks.bootstrapped = false
    system.matches = false
    vi.stubGlobal('matchMedia', () => system)
    vi.stubGlobal('api', { setTheme: nativeSetTheme })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    document.body.removeAttribute('theme-mode')
    delete document.body.dataset.themePreset
    document.body.classList.remove('light', 'dark')
    document.documentElement.classList.remove('light', 'dark')
  })

  it('applies every preset and mode, including storage events from another renderer', () => {
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>
    )
    expect(document.body).toHaveAttribute('data-theme-preset', 'codex')
    expect(document.body).toHaveAttribute('theme-mode', 'light')

    system.matches = true
    act(() => {
      system.dispatchEvent(new Event('change'))
    })
    expect(document.body).toHaveAttribute('theme-mode', 'dark')
    expect(document.documentElement).toHaveClass('dark')

    act(() => {
      uiThemePreset.set('zen-paper')
    })
    expect(document.body).toHaveAttribute('data-theme-preset', 'zen-paper')
    expect(document.body).toHaveAttribute('theme-mode', 'dark')

    system.matches = false
    act(() => {
      system.dispatchEvent(new Event('change'))
    })
    expect(document.body).toHaveAttribute('theme-mode', 'light')

    act(() => {
      localStorage.setItem('zen-ui:theme-preset', 'codex')
      window.dispatchEvent(new StorageEvent('storage', { key: 'zen-ui:theme-preset', storageArea: localStorage }))
    })
    expect(document.body).toHaveAttribute('data-theme-preset', 'codex')
  })

  it('uses the saved mode for the native window after Redux finishes loading', () => {
    const view = render(
      <ThemeProvider syncNative>
        <ThemeProbe />
      </ThemeProvider>
    )
    expect(nativeSetTheme).not.toHaveBeenCalled()

    act(() => {
      mocks.bootstrapped = true
      mocks.theme = ThemeMode.dark
      mocks.persistEvents.dispatchEvent(new Event('change'))
    })
    expect(nativeSetTheme).toHaveBeenCalledExactlyOnceWith(ThemeMode.dark)
    expect(document.body).toHaveAttribute('theme-mode', 'dark')

    act(() => {
      screen.getByRole('button', { name: 'dark' }).click()
    })
    expect(mocks.setTheme).toHaveBeenCalledExactlyOnceWith(ThemeMode.light)

    mocks.theme = ThemeMode.light
    view.rerender(
      <ThemeProvider syncNative>
        <ThemeProbe />
      </ThemeProvider>
    )
    expect(nativeSetTheme).toHaveBeenLastCalledWith(ThemeMode.light)
    expect(document.body).toHaveAttribute('theme-mode', 'light')
  })

  it('remembers the sidebar state separately for the image workbench', () => {
    expect(uiSidebar.get()).toBe('expanded')
    expect(uiPaintingsSidebar.get()).toBe('collapsed')
    uiSidebar.set('collapsed')
    uiPaintingsSidebar.set('expanded')
    expect(uiSidebar.get()).toBe('collapsed')
    expect(uiPaintingsSidebar.get()).toBe('expanded')
  })
})
