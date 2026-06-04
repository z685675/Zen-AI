import { ANNOUNCEMENT_FEED_URL, platform } from '@renderer/config/constant'
import type { AnnouncementItem, AnnouncementPayload, AnnouncementPlatform } from '@renderer/types/announcement'

const CACHE_KEY = 'announcements.payload.v1'
const DISMISSED_KEY = 'announcements.dismissed.ids.v1'

export type AnnouncementViewItem = AnnouncementItem & {
  publishedAt: string
}

const toTimestamp = (value?: string): number => {
  if (!value) {
    return 0
  }

  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

const normalizeVersionParts = (version: string): number[] => {
  const match = version.match(/\d+(?:\.\d+)*/)
  return (match?.[0] ?? '0')
    .split('.')
    .slice(0, 4)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0))
}

const compareVersions = (left: string, right: string): number => {
  const leftParts = normalizeVersionParts(left)
  const rightParts = normalizeVersionParts(right)
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0
    const rightPart = rightParts[index] ?? 0

    if (leftPart > rightPart) return 1
    if (leftPart < rightPart) return -1
  }

  return 0
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isAnnouncementType = (value: unknown): value is AnnouncementItem['type'] => {
  return value === 'announcement' || value === 'urgent'
}

const isAnnouncementPlatform = (value: unknown): value is AnnouncementPlatform => {
  return value === 'win32' || value === 'darwin' || value === 'linux'
}

const normalizeItem = (value: unknown): AnnouncementItem | null => {
  if (!isRecord(value)) {
    return null
  }

  if (
    typeof value.id !== 'string' ||
    !isAnnouncementType(value.type) ||
    typeof value.enabled !== 'boolean' ||
    typeof value.title !== 'string' ||
    typeof value.content !== 'string'
  ) {
    return null
  }

  const item: AnnouncementItem = {
    id: value.id,
    type: value.type,
    enabled: value.enabled,
    title: value.title,
    content: value.content
  }

  if (value.level === 'info' || value.level === 'success' || value.level === 'warning' || value.level === 'error') {
    item.level = value.level
  }

  if (typeof value.priority === 'number' && Number.isFinite(value.priority)) {
    item.priority = value.priority
  }

  if (Array.isArray(value.platforms)) {
    item.platforms = value.platforms.filter(isAnnouncementPlatform)
  }

  if (typeof value.minAppVersion === 'string') item.minAppVersion = value.minAppVersion
  if (typeof value.maxAppVersion === 'string') item.maxAppVersion = value.maxAppVersion
  if (typeof value.startsAt === 'string') item.startsAt = value.startsAt
  if (typeof value.endsAt === 'string') item.endsAt = value.endsAt

  if (isRecord(value.link) && typeof value.link.label === 'string' && typeof value.link.url === 'string') {
    item.link = {
      label: value.link.label,
      url: value.link.url
    }
  }

  return item
}

const normalizePayload = (value: unknown): AnnouncementPayload | null => {
  if (!isRecord(value) || value.version !== 1 || typeof value.updatedAt !== 'string' || !Array.isArray(value.items)) {
    return null
  }

  return {
    version: 1,
    updatedAt: value.updatedAt,
    items: value.items.map(normalizeItem).filter((item): item is AnnouncementItem => Boolean(item))
  }
}

const getCurrentPlatform = (): AnnouncementPlatform | undefined => {
  if (platform === 'win32' || platform === 'darwin' || platform === 'linux') {
    return platform
  }

  return undefined
}

export const announcementService = {
  async fetchPayload(): Promise<AnnouncementPayload | null> {
    const response = await fetch(`${ANNOUNCEMENT_FEED_URL}?t=${Date.now()}`, {
      cache: 'no-store'
    })

    if (!response.ok) {
      throw new Error(`Announcement feed failed: ${response.status}`)
    }

    const payload = normalizePayload(await response.json())

    if (payload) {
      this.saveCachedPayload(payload)
    }

    return payload
  },

  getCachedPayload(): AnnouncementPayload | null {
    try {
      const raw = localStorage.getItem(CACHE_KEY)
      return raw ? normalizePayload(JSON.parse(raw)) : null
    } catch {
      return null
    }
  },

  saveCachedPayload(payload: AnnouncementPayload): void {
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload))
  },

  getDismissedIds(): string[] {
    try {
      const value = JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]')
      return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
    } catch {
      return []
    }
  },

  dismissAnnouncement(id: string): string[] {
    const ids = [...new Set([...this.getDismissedIds(), id])]
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids))
    return ids
  },

  filterItems(payload: AnnouncementPayload | null, appVersion: string): AnnouncementViewItem[] {
    if (!payload) {
      return []
    }

    const now = Date.now()
    const currentPlatform = getCurrentPlatform()

    return payload.items
      .filter((item) => {
        if (!item.enabled) return false
        if (item.platforms?.length && (!currentPlatform || !item.platforms.includes(currentPlatform))) return false
        if (item.startsAt && toTimestamp(item.startsAt) > now) return false
        if (item.endsAt && toTimestamp(item.endsAt) < now) return false
        if (item.minAppVersion && compareVersions(appVersion, item.minAppVersion) < 0) return false
        if (item.maxAppVersion && compareVersions(appVersion, item.maxAppVersion) > 0) return false
        return true
      })
      .map((item) => ({
        ...item,
        publishedAt: item.startsAt || payload.updatedAt
      }))
  },

  getLatestAnnouncements(items: AnnouncementViewItem[], limit = 3): AnnouncementViewItem[] {
    return items
      .filter((item) => item.type === 'announcement')
      .sort((a, b) => toTimestamp(b.publishedAt) - toTimestamp(a.publishedAt))
      .slice(0, limit)
  },

  getUrgentItems(items: AnnouncementViewItem[]): AnnouncementViewItem[] {
    return items
      .filter((item) => item.type === 'urgent')
      .sort((a, b) => {
        const priorityDiff = (b.priority ?? 0) - (a.priority ?? 0)
        return priorityDiff || toTimestamp(b.publishedAt) - toTimestamp(a.publishedAt)
      })
      .slice(0, 1)
  }
}
