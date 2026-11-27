import { isMac } from '@renderer/config/constant'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { uiPaintingsSidebar, uiSidebar } from '@renderer/services/UiThemePresetService'
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, SECOND_MIN_WINDOW_WIDTH } from '@shared/config/constant'
import { IpcChannel } from '@shared/IpcChannel'
import type { PropsWithChildren } from 'react'
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'

export const SIDEBAR_RESIZED = 'zen-ai:sidebar-resized'

type CreateAction = () => void

export interface ActiveSidebarModel {
  id?: string
  name?: string
  provider?: string
}

interface SidebarContextValue {
  collapsed: boolean
  toggleSidebar: () => void
  bodySlot: HTMLElement | null
  titleSlot: HTMLElement | null
  setBodySlot: (node: HTMLElement | null) => void
  setTitleSlot: (node: HTMLElement | null) => void
  requestCreate: () => void
  registerCreate: (action: CreateAction) => () => void
  activeModel?: ActiveSidebarModel
  setActiveModel: (model?: ActiveSidebarModel) => void
}

const SidebarContext = createContext<SidebarContextValue | null>(null)

export const useSidebarShell = () => use(SidebarContext)

const isDefaultToggle = (event: KeyboardEvent) =>
  event.code === 'KeyB' &&
  (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
  !event.altKey &&
  !event.shiftKey

export function SidebarSlotProvider({ children }: PropsWithChildren) {
  const { pathname, search, state, key } = useLocation()
  const navigate = useNavigate()
  const paintings = pathname === '/paintings' || pathname.startsWith('/paintings/')
  const preference = paintings ? uiPaintingsSidebar : uiSidebar
  const collapsed = useSyncExternalStore(preference.subscribe, preference.get) === 'collapsed'
  const [bodySlot, setBodySlot] = useState<HTMLElement | null>(null)
  const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null)
  const [activeModel, setActiveModel] = useState<ActiveSidebarModel | undefined>(undefined)
  const [registration, setRegistration] = useState<{ key: string; action: CreateAction }>()
  const handledCreate = useRef<string>(undefined)
  const createAction = registration?.key === key ? registration.action : undefined
  const toggleSidebar = useCallback(() => {
    preference.set(preference.get() === 'collapsed' ? 'expanded' : 'collapsed')
  }, [preference])

  useEffect(() => {
    void window.api.window.setMinimumSize(collapsed ? SECOND_MIN_WINDOW_WIDTH : MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
  }, [collapsed])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isDefaultToggle(event)) return
      event.preventDefault()
      if (!event.repeat) toggleSidebar()
    }
    window.addEventListener('keydown', onKeyDown)
    const stopNative = window.electron.ipcRenderer.on(IpcChannel.Windows_ToggleSidebar, toggleSidebar)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      stopNative()
    }
  }, [toggleSidebar])

  useShortcut('toggle_show_assistants', (event) => {
    if (!isDefaultToggle(event) && !event.repeat) toggleSidebar()
  })

  const registerCreate = useCallback(
    (action: CreateAction) => {
      setRegistration({ key, action })
      return () => {
        setRegistration((current) => (current?.action === action ? undefined : current))
      }
    },
    [key]
  )

  useEffect(() => {
    if (!state?.createTask || pathname !== '/new-assistant' || !createAction || handledCreate.current === key) return
    handledCreate.current = key
    navigate(pathname, { replace: true, state: null })
    createAction()
  }, [createAction, key, navigate, pathname, state])

  const requestCreate = () => {
    if (pathname === '/' || pathname === '/notes') {
      createAction?.()
      return
    }
    if (pathname === '/new-assistant' && new URLSearchParams(search).get('history') !== 'legacy' && createAction) {
      createAction()
      return
    }
    navigate('/new-assistant', { state: { createTask: true } })
  }

  useShortcut('new_topic', (event) => {
    if (pathname !== '/' && pathname !== '/internal-assistant' && !event.repeat) requestCreate()
  })

  return (
    <SidebarContext
      value={{
        collapsed,
        toggleSidebar,
        bodySlot,
        titleSlot,
        setBodySlot,
        setTitleSlot,
        requestCreate,
        registerCreate,
        activeModel,
        setActiveModel
      }}>
      {children}
    </SidebarContext>
  )
}

export function SidebarBodySlot({ children }: PropsWithChildren) {
  const shell = useSidebarShell()
  if (!shell) return children
  return shell.bodySlot ? createPortal(children, shell.bodySlot) : null
}

export function AppTitleSlot({ children }: PropsWithChildren) {
  const shell = useSidebarShell()
  if (!shell) return children
  return shell.titleSlot ? createPortal(children, shell.titleSlot) : null
}

export function useSidebarCreateAction(action: CreateAction, ready = true) {
  const register = useSidebarShell()?.registerCreate
  const latest = useRef(action)
  useLayoutEffect(() => {
    latest.current = action
  }, [action])
  useLayoutEffect(() => (ready ? register?.(() => latest.current()) : undefined), [ready, register])
}

export function useSidebarActiveModel(model?: ActiveSidebarModel) {
  const setActiveModel = useSidebarShell()?.setActiveModel
  const id = model?.id
  const name = model?.name
  const provider = model?.provider

  useEffect(() => {
    if (!setActiveModel) return
    setActiveModel(id ? { id, name, provider } : undefined)
    return () => {
      setActiveModel(undefined)
    }
  }, [id, name, provider, setActiveModel])
}
