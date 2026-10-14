import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import type { AgentActionRequiredPayload } from '@shared/config/types'
import { IpcChannel } from '@shared/IpcChannel'

import { windowService } from '../../WindowService'

/** Bring the app forward when any agent needs a user-controlled step. */
export function broadcastAgentActionRequired(payload: AgentActionRequiredPayload): void {
  const mainWindow = windowService.getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (payload.agentId === DEFAULT_OPENCODE_AGENT_ID) {
    // Do not steal focus from login/CAPTCHA. Renderer sends a private, targeted notification.
    mainWindow.webContents.send(IpcChannel.Agent_ActionRequired, payload)
    return
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow.show()
  mainWindow.focus()
  mainWindow.webContents.send(IpcChannel.Agent_ActionRequired, payload)
}
