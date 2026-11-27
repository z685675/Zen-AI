import { useAppDispatch, useAppSelector } from '@renderer/store'
import type { UserTheme } from '@renderer/store/settings'
import { setUserTheme } from '@renderer/store/settings'
import Color from 'color'
import { useCallback } from 'react'

export const LEGACY_PRIMARY_COLOR = '#00b96b'

export function getCustomPrimary(value: string) {
  if (!value || value.toLowerCase() === LEGACY_PRIMARY_COLOR) return undefined
  try {
    return Color(value)
  } catch {
    return undefined
  }
}

export function getPrimaryForeground(color: ReturnType<typeof Color>) {
  const dark = Color('#09090b')
  const light = Color('#ffffff')
  return color.contrast(dark) > color.contrast(light) ? dark.hex() : light.hex()
}

function applyUserTheme(theme: UserTheme) {
  const colorPrimary = getCustomPrimary(theme.colorPrimary)
  const body = document.body.style
  if (colorPrimary) {
    body.setProperty('--color-primary', colorPrimary.toString())
    body.setProperty('--color-primary-foreground', getPrimaryForeground(colorPrimary))
    body.setProperty('--color-primary-soft', colorPrimary.alpha(0.6).toString())
    body.setProperty('--color-primary-mute', colorPrimary.alpha(0.3).toString())
  } else {
    body.removeProperty('--color-primary')
    body.removeProperty('--color-primary-foreground')
    body.removeProperty('--color-primary-soft')
    body.removeProperty('--color-primary-mute')
  }

  const root = document.documentElement.style
  root.setProperty('--user-font-family', theme.userFontFamily ? JSON.stringify(theme.userFontFamily) : 'initial')
  root.setProperty(
    '--user-code-font-family',
    theme.userCodeFontFamily ? JSON.stringify(theme.userCodeFontFamily) : 'initial'
  )
}

export default function useUserTheme() {
  const userTheme = useAppSelector((state) => state.settings.userTheme)
  const dispatch = useAppDispatch()
  const initUserTheme = useCallback(() => applyUserTheme(userTheme), [userTheme])

  return {
    initUserTheme,

    setUserTheme(userTheme: UserTheme) {
      dispatch(setUserTheme(userTheme))
      applyUserTheme(userTheme)
    }
  }
}
