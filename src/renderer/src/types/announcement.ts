export type AnnouncementType = 'announcement' | 'urgent'

export type AnnouncementLevel = 'info' | 'success' | 'warning' | 'error'

export type AnnouncementPlatform = 'win32' | 'darwin' | 'linux'

export type AnnouncementLink = {
  label: string
  url: string
}

export type AnnouncementItem = {
  id: string
  type: AnnouncementType
  enabled: boolean
  title: string
  content: string
  level?: AnnouncementLevel
  priority?: number
  platforms?: AnnouncementPlatform[]
  minAppVersion?: string
  maxAppVersion?: string
  startsAt?: string
  endsAt?: string
  link?: AnnouncementLink
}

export type AnnouncementPayload = {
  version: 1
  updatedAt: string
  items: AnnouncementItem[]
}
