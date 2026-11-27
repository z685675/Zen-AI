import { flushSync } from 'react-dom'

export const UI_THEME_PRESETS = ['codex', 'zen-paper'] as const
export type UiThemePreset = (typeof UI_THEME_PRESETS)[number]
export const UI_ROUTE_TRANSITIONS = ['crossfade', 'instant'] as const
export type UiRouteTransition = (typeof UI_ROUTE_TRANSITIONS)[number]

const EVENT_NAME = 'zen-ui-preference-changed'

function preference<T extends string>(key: string, defaultValue: T, choices: readonly T[]) {
  const storageKey = `zen-ui:${key}`

  return {
    get(): T {
      const stored = localStorage.getItem(storageKey)
      return choices.find((choice) => choice === stored) ?? defaultValue
    },
    set(value: T) {
      if (localStorage.getItem(storageKey) === value) return
      localStorage.setItem(storageKey, value)
      window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: storageKey }))
    },
    subscribe(listener: () => void) {
      const onLocalChange = (event: Event) => {
        if ((event as CustomEvent<string>).detail === storageKey) listener()
      }
      const onStorage = (event: StorageEvent) => {
        if (event.storageArea === localStorage && (event.key === storageKey || event.key === null)) listener()
      }
      window.addEventListener(EVENT_NAME, onLocalChange)
      window.addEventListener('storage', onStorage)
      return () => {
        window.removeEventListener(EVENT_NAME, onLocalChange)
        window.removeEventListener('storage', onStorage)
      }
    }
  }
}

const sidebarStates = ['expanded', 'collapsed'] as const

export const uiThemePreset = preference('theme-preset', 'codex', UI_THEME_PRESETS)
export const uiSidebar = preference('sidebar', 'expanded', sidebarStates)
export const uiPaintingsSidebar = preference('paintings-sidebar', 'collapsed', sidebarStates)
export const uiRouteTransition = preference('route-transition', 'crossfade', UI_ROUTE_TRANSITIONS)

function isNativeOverlayRoute(path: string): boolean {
  return path === '/paintings' || path.startsWith('/paintings/')
}

export function runRouteTransition(currentPath: string, targetPath: string, commit: () => void): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown }
  const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
  const currentGroup = currentPath.split('/')[1] || 'chat'
  const targetGroup = targetPath.split('/')[1] || 'chat'

  if (
    uiRouteTransition.get() !== 'crossfade' ||
    prefersReducedMotion ||
    typeof doc.startViewTransition !== 'function' ||
    currentGroup === targetGroup ||
    isNativeOverlayRoute(currentPath) ||
    isNativeOverlayRoute(targetPath)
  ) {
    commit()
    return
  }

  doc.startViewTransition(() => {
    // eslint-disable-next-line @eslint-react/dom/no-flush-sync -- Commit the route before Chromium captures the new view.
    flushSync(commit)
  })
}
