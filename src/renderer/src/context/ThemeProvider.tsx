import { isMac, isWin } from '@renderer/config/constant'
import { useNavbarPosition, useSettings } from '@renderer/hooks/useSettings'
import useUserTheme from '@renderer/hooks/useUserTheme'
import { type UiThemePreset, uiThemePreset } from '@renderer/services/UiThemePresetService'
import { persistor } from '@renderer/store'
import { ThemeMode } from '@renderer/types'
import type { FC, PropsWithChildren } from 'react'
import { createContext, use, useEffect, useLayoutEffect, useSyncExternalStore } from 'react'

export type ResolvedThemeMode = ThemeMode.light | ThemeMode.dark

interface ThemeContextType {
  theme: ResolvedThemeMode
  settedTheme: ThemeMode
  toggleTheme: () => void
  setTheme: (theme: ThemeMode) => void
  preset: UiThemePreset
  setPreset: (preset: UiThemePreset) => void
}

const ThemeContext = createContext<ThemeContextType>({
  theme: ThemeMode.light,
  settedTheme: ThemeMode.system,
  toggleTheme: () => {},
  setTheme: () => {},
  preset: 'codex',
  setPreset: () => {}
})

interface ThemeProviderProps extends PropsWithChildren {
  syncNative?: boolean
}

const SYSTEM_DARK = '(prefers-color-scheme: dark)'
const getSystemDark = () => window.matchMedia?.(SYSTEM_DARK)?.matches ?? false
const subscribeSystemDark = (onChange: () => void) => {
  const media = window.matchMedia?.(SYSTEM_DARK)
  media?.addEventListener('change', onChange)
  return () => media?.removeEventListener('change', onChange)
}
const getBootstrapped = () => persistor.getState().bootstrapped

export const ThemeProvider: FC<ThemeProviderProps> = ({ children, syncNative = false }) => {
  const { theme: settedTheme, setTheme, language } = useSettings()
  const systemDark = useSyncExternalStore(subscribeSystemDark, getSystemDark)
  const preset = useSyncExternalStore(uiThemePreset.subscribe, uiThemePreset.get)
  const bootstrapped = useSyncExternalStore(persistor.subscribe, getBootstrapped)
  const actualTheme = settedTheme === ThemeMode.system ? (systemDark ? ThemeMode.dark : ThemeMode.light) : settedTheme
  const { initUserTheme } = useUserTheme()
  const { navbarPosition } = useNavbarPosition()

  useLayoutEffect(() => {
    document.body.setAttribute('os', isMac ? 'mac' : isWin ? 'windows' : 'linux')
    document.body.setAttribute('navbar-position', syncNative ? 'left' : navbarPosition)
    document.documentElement.lang = language
  }, [language, navbarPosition, syncNative])

  useLayoutEffect(() => {
    document.body.dataset.themePreset = preset
    document.body.setAttribute('theme-mode', actualTheme)
    for (const element of [document.body, document.documentElement]) {
      element.classList.toggle('dark', actualTheme === ThemeMode.dark)
      element.classList.toggle('light', actualTheme === ThemeMode.light)
    }
  }, [actualTheme, preset])

  useLayoutEffect(() => {
    initUserTheme()
  }, [initUserTheme])

  useEffect(() => {
    if (syncNative && bootstrapped) void window.api.setTheme(settedTheme)
  }, [bootstrapped, settedTheme, syncNative])

  return (
    <ThemeContext
      value={{
        theme: actualTheme,
        settedTheme,
        toggleTheme: () => setTheme(actualTheme === ThemeMode.dark ? ThemeMode.light : ThemeMode.dark),
        setTheme,
        preset,
        setPreset: uiThemePreset.set
      }}>
      {children}
    </ThemeContext>
  )
}

export const useTheme = () => use(ThemeContext)
