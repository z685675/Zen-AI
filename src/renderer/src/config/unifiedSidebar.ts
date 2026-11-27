import type { LucideIcon } from 'lucide-react'
import {
  Code,
  FileSearch,
  Folder,
  Image,
  Languages,
  LayoutGrid,
  MessageSquare,
  NotebookPen,
  Sparkles,
  Store
} from 'lucide-react'

export type SidebarEntryId =
  | 'new_assistant'
  | 'assistants'
  | 'paintings'
  | 'store'
  | 'notes'
  | 'translate'
  | 'files'
  | 'apps'
  | 'knowledge'
  | 'code'

export type SidebarEntryPlacement = 'primary' | 'more' | 'hidden'

export interface UnifiedSidebarEntry {
  id: SidebarEntryId
  path: string
  end?: boolean
  icon: LucideIcon
  labelKey: string
  defaultPlacement: SidebarEntryPlacement
  developerOnly?: boolean
  required?: boolean
}

export const UNIFIED_SIDEBAR_ENTRIES: readonly UnifiedSidebarEntry[] = [
  {
    id: 'assistants',
    path: '/',
    end: true,
    icon: MessageSquare,
    labelKey: 'assistants.title',
    defaultPlacement: 'primary',
    required: true
  },
  {
    id: 'new_assistant',
    path: '/new-assistant',
    icon: Sparkles,
    labelKey: 'common.agent_one',
    defaultPlacement: 'primary'
  },
  {
    id: 'paintings',
    path: '/paintings',
    icon: Image,
    labelKey: 'app_shell.image_workbench',
    defaultPlacement: 'primary'
  },
  {
    id: 'store',
    path: '/store',
    icon: Store,
    labelKey: 'assistants.presets.title',
    defaultPlacement: 'more'
  },
  {
    id: 'notes',
    path: '/notes',
    icon: NotebookPen,
    labelKey: 'notes.title',
    defaultPlacement: 'more'
  },
  {
    id: 'translate',
    path: '/translate',
    icon: Languages,
    labelKey: 'translate.title',
    defaultPlacement: 'more'
  },
  {
    id: 'files',
    path: '/files',
    icon: Folder,
    labelKey: 'files.title',
    defaultPlacement: 'more'
  },
  {
    id: 'apps',
    path: '/apps',
    icon: LayoutGrid,
    labelKey: 'minapp.title',
    defaultPlacement: 'more',
    developerOnly: true
  },
  {
    id: 'knowledge',
    path: '/knowledge',
    icon: FileSearch,
    labelKey: 'knowledge.title',
    defaultPlacement: 'more',
    developerOnly: true
  },
  {
    id: 'code',
    path: '/code',
    icon: Code,
    labelKey: 'code.title',
    defaultPlacement: 'more',
    developerOnly: true
  }
] as const

export type SidebarPlacementMap = Record<SidebarEntryId, SidebarEntryPlacement>

export const DEFAULT_SIDEBAR_PLACEMENTS: SidebarPlacementMap = Object.fromEntries(
  UNIFIED_SIDEBAR_ENTRIES.map((entry) => [entry.id, entry.defaultPlacement])
) as SidebarPlacementMap

const STORAGE_KEY = 'zen-ui:sidebar-placements'
const EVENT_NAME = 'zen-ui-preference-changed'
const VALID_PLACEMENTS: readonly SidebarEntryPlacement[] = ['primary', 'more', 'hidden']

let cachedRaw: string | null | undefined = undefined
let cachedSnapshot: SidebarPlacementMap = DEFAULT_SIDEBAR_PLACEMENTS

function normalizePlacements(parsed: unknown): SidebarPlacementMap {
  if (!parsed || typeof parsed !== 'object') {
    return DEFAULT_SIDEBAR_PLACEMENTS
  }

  const rawMap = parsed as Record<string, unknown>
  let changed = false
  const next = { ...DEFAULT_SIDEBAR_PLACEMENTS }

  for (const entry of UNIFIED_SIDEBAR_ENTRIES) {
    const candidate = rawMap[entry.id]
    if (typeof candidate === 'string' && VALID_PLACEMENTS.includes(candidate as SidebarEntryPlacement)) {
      const safePlacement: SidebarEntryPlacement =
        entry.required && candidate === 'hidden' ? 'primary' : (candidate as SidebarEntryPlacement)
      if (safePlacement !== next[entry.id]) {
        next[entry.id] = safePlacement
        changed = true
      }
    }
  }

  return changed ? next : DEFAULT_SIDEBAR_PLACEMENTS
}

export const uiSidebarPlacements = {
  get(): SidebarPlacementMap {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === cachedRaw) {
      return cachedSnapshot
    }
    cachedRaw = raw
    if (!raw) {
      cachedSnapshot = DEFAULT_SIDEBAR_PLACEMENTS
      return cachedSnapshot
    }
    try {
      cachedSnapshot = normalizePlacements(JSON.parse(raw))
    } catch {
      cachedSnapshot = DEFAULT_SIDEBAR_PLACEMENTS
    }
    return cachedSnapshot
  },

  setPlacement(id: SidebarEntryId, placement: SidebarEntryPlacement) {
    const entry = UNIFIED_SIDEBAR_ENTRIES.find((item) => item.id === id)
    if (!entry) return
    const safePlacement: SidebarEntryPlacement = entry.required && placement === 'hidden' ? 'primary' : placement
    const current = this.get()
    if (current[id] === safePlacement) return
    const next: SidebarPlacementMap = { ...current, [id]: safePlacement }
    const serialized = JSON.stringify(next)
    localStorage.setItem(STORAGE_KEY, serialized)
    cachedRaw = serialized
    cachedSnapshot = next
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: STORAGE_KEY }))
  },

  reset() {
    if (localStorage.getItem(STORAGE_KEY) === null) return
    localStorage.removeItem(STORAGE_KEY)
    cachedRaw = null
    cachedSnapshot = DEFAULT_SIDEBAR_PLACEMENTS
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: STORAGE_KEY }))
  },

  subscribe(listener: () => void) {
    const onLocalChange = (event: Event) => {
      if ((event as CustomEvent<string>).detail === STORAGE_KEY) listener()
    }
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea === localStorage && (event.key === STORAGE_KEY || event.key === null)) listener()
    }
    window.addEventListener(EVENT_NAME, onLocalChange)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(EVENT_NAME, onLocalChange)
      window.removeEventListener('storage', onStorage)
    }
  }
}
