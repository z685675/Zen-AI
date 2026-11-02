import { loggerService } from '@logger'
import type { BrowserView, BrowserWindow } from 'electron'

type McpLogger = Pick<typeof loggerService, 'debug' | 'error' | 'info' | 'silly' | 'verbose' | 'warn'>

export const logger: McpLogger = loggerService.withContext('MCPBrowserCDP')

export interface TabInfo {
  id: string
  view: BrowserView
  url: string
  title: string
  lastActive: number
  userAction?: BrowserUserAction
  userActionFingerprint?: string
  dismissedUserActionFingerprint?: string
  lastUserActionContinuation?: {
    fingerprint: string
    reason: BrowserUserActionReason
    continuedAt: number
  }
  userActionDetectionTimer?: ReturnType<typeof setTimeout>
  manualControl?: boolean
  externalBrowserOpened?: boolean
}

export interface WindowInfo {
  windowKey: string
  privateMode: boolean
  window: BrowserWindow
  tabs: Map<string, TabInfo>
  activeTabId: string | null
  lastActive: number
  tabBarView?: BrowserView
  handoff?: BrowserHandoffInfo
}

export interface BrowserHandoffInfo {
  id: string
  message: string
  reason?: string
  tabId?: string
  createdAt: number
  resolve: (value: { id: string; status: 'continued' | 'closed' }) => void
  timeoutHandle?: ReturnType<typeof setTimeout>
}

export type BrowserUserActionReason =
  | 'login_required'
  | 'captcha'
  | 'verification'
  | 'two_factor'
  | 'authorization'
  | 'account_access'

export interface BrowserUserAction {
  reason: BrowserUserActionReason
  message: string
  url: string
  detectedAt: number
}
