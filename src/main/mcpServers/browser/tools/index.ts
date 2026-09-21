export { ClearBrowserDataSchema, clearBrowserDataToolDefinition, handleClearBrowserData } from './clearData'
export {
  handleListDownloads,
  handleWaitForDownload,
  listDownloadsToolDefinition,
  WaitForDownloadSchema,
  waitForDownloadToolDefinition
} from './downloads'
export { ExecuteSchema, executeToolDefinition, handleExecute } from './execute'
export { handleOpen, OpenSchema, openToolDefinition } from './open'
export { handleReset, resetToolDefinition } from './reset'
export { handleScreenshot, screenshotToolDefinition } from './screenshot'
export { handleSnapshot, snapshotToolDefinition } from './snapshot'
export {
  closeTabToolDefinition,
  handleCloseTab,
  handleListTabs,
  handleSwitchTab,
  listTabsToolDefinition,
  switchTabToolDefinition
} from './tabs'
export { handleWaitForUser, WaitForUserSchema, waitForUserToolDefinition } from './waitForUser'

import type { CdpBrowserController } from '../controller'
import { clearBrowserDataToolDefinition, handleClearBrowserData } from './clearData'
import {
  handleListDownloads,
  handleWaitForDownload,
  listDownloadsToolDefinition,
  waitForDownloadToolDefinition
} from './downloads'
import { executeToolDefinition, handleExecute } from './execute'
import { handleOpen, openToolDefinition } from './open'
import { handleReset, resetToolDefinition } from './reset'
import { handleScreenshot, screenshotToolDefinition } from './screenshot'
import { handleSnapshot, snapshotToolDefinition } from './snapshot'
import {
  closeTabToolDefinition,
  handleCloseTab,
  handleListTabs,
  handleSwitchTab,
  listTabsToolDefinition,
  switchTabToolDefinition
} from './tabs'
import type { ToolContent } from './utils'
import { handleWaitForUser, waitForUserToolDefinition } from './waitForUser'

export const toolDefinitions = [
  openToolDefinition,
  executeToolDefinition,
  listDownloadsToolDefinition,
  waitForDownloadToolDefinition,
  clearBrowserDataToolDefinition,
  screenshotToolDefinition,
  snapshotToolDefinition,
  listTabsToolDefinition,
  switchTabToolDefinition,
  closeTabToolDefinition,
  waitForUserToolDefinition,
  resetToolDefinition
]

export const toolHandlers: Record<
  string,
  (controller: CdpBrowserController, args: unknown) => Promise<{ content: ToolContent[]; isError: boolean }>
> = {
  open: handleOpen,
  execute: handleExecute,
  list_downloads: handleListDownloads,
  wait_for_download: handleWaitForDownload,
  clear_browser_data: handleClearBrowserData,
  screenshot: handleScreenshot,
  snapshot: handleSnapshot,
  list_tabs: handleListTabs,
  switch_tab: handleSwitchTab,
  close_tab: handleCloseTab,
  wait_for_user: handleWaitForUser,
  reset: handleReset
}
