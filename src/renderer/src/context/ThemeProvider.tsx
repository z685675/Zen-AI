import { isMac, isWin } from '@renderer/config/constant'
import { useNavbarPosition, useSettings } from '@renderer/hooks/useSettings'
import useUserTheme from '@renderer/hooks/useUserTheme'
import { ThemeMode } from '@renderer/types'
import { IpcChannel } from '@shared/IpcChannel'
import type { PropsWithChildren } from 'react'
import React, { createContext, use, useCallback, useEffect, useState } from 'react'

interface ThemeContextType {
  theme: ThemeMode
  settedTheme: ThemeMode
  toggleTheme: () => void
  setTheme: (theme: ThemeMode) => void
}

const ONLY_SUPPORTED_THEME = ThemeMode.light

const ThemeContext = createContext<ThemeContextType>({
  theme: ONLY_SUPPORTED_THEME,
  settedTheme: ONLY_SUPPORTED_THEME,
  toggleTheme: () => {},
  setTheme: () => {}
})

interface ThemeProviderProps extends PropsWithChildren {
  defaultTheme?: ThemeMode
}

const tailwindThemeChange = (theme: ThemeMode) => {
  const root = window.document.documentElement
  root.classList.remove('light', 'dark')
  root.classList.add(theme)
}

export const ThemeProvider: React.FC<ThemeProviderProps> = ({ children }) => {
  const { theme: settedTheme, setTheme: setSettedTheme, language } = useSettings()
  const [actualTheme, setActualTheme] = useState<ThemeMode>(ONLY_SUPPORTED_THEME)
  const { initUserTheme } = useUserTheme()
  const { navbarPosition } = useNavbarPosition()

  const applyLightTheme = useCallback(() => {
    if (settedTheme !== ONLY_SUPPORTED_THEME) {
      setSettedTheme(ONLY_SUPPORTED_THEME)
    }
  }, [setSettedTheme, settedTheme])

  const toggleTheme = () => {
    applyLightTheme()
  }

  useEffect(() => {
    document.body.setAttribute('os', isMac ? 'mac' : isWin ? 'windows' : 'linux')
    document.body.setAttribute('theme-mode', ONLY_SUPPORTED_THEME)
    document.body.classList.remove('dark')
    document.body.classList.add('light')
    document.body.setAttribute('navbar-position', navbarPosition)
    document.documentElement.lang = language

    applyLightTheme()
    initUserTheme()

    return window.electron.ipcRenderer.on(IpcChannel.ThemeUpdated, (_, actualTheme: ThemeMode) => {
      if (actualTheme !== ONLY_SUPPORTED_THEME) {
        void window.api.setTheme(ONLY_SUPPORTED_THEME)
        return
      }

      document.body.setAttribute('theme-mode', ONLY_SUPPORTED_THEME)
      setActualTheme(ONLY_SUPPORTED_THEME)
    })
  }, [applyLightTheme, initUserTheme, language, navbarPosition])

  useEffect(() => {
    tailwindThemeChange(ONLY_SUPPORTED_THEME)
  }, [])

  useEffect(() => {
    setActualTheme(ONLY_SUPPORTED_THEME)
    void window.api.setTheme(ONLY_SUPPORTED_THEME)
    applyLightTheme()
  }, [applyLightTheme])

  return (
    <ThemeContext
      value={{
        theme: actualTheme,
        settedTheme: ONLY_SUPPORTED_THEME,
        toggleTheme,
        setTheme: () => applyLightTheme()
      }}>
      {children}
    </ThemeContext>
  )
}

export const useTheme = () => use(ThemeContext)
