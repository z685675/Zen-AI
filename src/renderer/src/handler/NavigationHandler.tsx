import { useAgentClient } from '@renderer/hooks/agents/useAgentClient'
import {
  ASSISTANT_NOTIFICATION_OPEN,
  notifyAssistantTask,
  openAssistantNotification,
  readAssistantNotificationTarget
} from '@renderer/services/AssistantNotificationService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { setActiveAgentId, setActiveSessionIdAction } from '@renderer/store/runtime'
import type { Notification } from '@renderer/types/notification'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import type { AgentActionRequiredPayload } from '@shared/config/types'
import { IpcChannel } from '@shared/IpcChannel'
import { AlertCircle } from 'lucide-react'
import { useEffect } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'

const NavigationHandler: React.FC = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const client = useAgentClient('opencode')
  const { t } = useTranslation()
  const showSettingsShortcutEnabled = useAppSelector(
    (state) => state.shortcuts.shortcuts.find((s) => s.key === 'show_settings')?.enabled
  )

  useHotkeys(
    'meta+, ! ctrl+,',
    function () {
      if (location.pathname.startsWith('/settings')) {
        return
      }
      navigate('/settings/provider')
    },
    {
      splitKey: '!',
      enableOnContentEditable: true,
      enableOnFormTags: true,
      enabled: showSettingsShortcutEnabled
    }
  )

  // Listen for navigate to About page event from macOS menu
  useEffect(() => {
    const handleNavigateToAbout = () => {
      navigate('/settings/about')
    }

    const removeListener = window.electron.ipcRenderer.on(IpcChannel.Windows_NavigateToAbout, handleNavigateToAbout)

    return () => {
      removeListener()
    }
  }, [navigate])

  useEffect(() => {
    let generation = 0
    const open = async (event: Event) => {
      const target = readAssistantNotificationTarget((event as CustomEvent).detail)
      if (!target) return
      const request = ++generation
      try {
        // Check existence before changing active selection; never recreate a deleted session.
        await client.getSession(target.agentId, target.sessionId, { timeout: 3000 })
        if (request !== generation) return
        window.dispatchEvent(new Event('zen-ai:close-agent-quick-entry'))
        dispatch(setActiveAgentId(target.agentId))
        dispatch(setActiveSessionIdAction(target))
        navigate('/new-assistant')
      } catch {
        if (request === generation) window.toast?.info(t('assistantPeripheral.sessionUnavailable'))
      }
    }
    const removeNativeClick = window.electron.ipcRenderer.on(
      'notification-click',
      (_event, notification: Notification) => {
        openAssistantNotification(notification?.meta)
      }
    )
    window.addEventListener(ASSISTANT_NOTIFICATION_OPEN, open)
    return () => {
      generation++
      removeNativeClick()
      window.removeEventListener(ASSISTANT_NOTIFICATION_OPEN, open)
    }
  }, [client, dispatch, navigate, t])

  useEffect(() => {
    const pending = new Set<string>()
    const handleAgentActionRequired = (_event: Electron.IpcRendererEvent, payload: AgentActionRequiredPayload) => {
      const key = `${payload.agentId}:${payload.sessionId}:${payload.requestId ?? payload.reason}`
      if (pending.has(key)) return
      pending.add(key)
      if (payload.agentId === DEFAULT_OPENCODE_AGENT_ID) {
        void notifyAssistantTask(
          { agentId: payload.agentId, sessionId: payload.sessionId },
          payload.requestId ?? key,
          'handoff'
        )
      }
      window.modal.confirm({
        centered: true,
        icon: <AlertCircle size={22} color="var(--color-warning)" />,
        title: t('agent.actionRequired.title'),
        content: payload.message,
        okText: t('agent.actionRequired.open'),
        cancelText: t('agent.actionRequired.later'),
        afterClose: () => pending.delete(key),
        onOk: async () => {
          if (payload.agentId === DEFAULT_OPENCODE_AGENT_ID) {
            try {
              await client.getSession(payload.agentId, payload.sessionId, { timeout: 3000 })
            } catch {
              window.toast?.info(t('assistantPeripheral.sessionUnavailable'))
              return
            }
          }
          window.dispatchEvent(new Event('zen-ai:close-agent-quick-entry'))
          dispatch(setActiveAgentId(payload.agentId))
          dispatch(setActiveSessionIdAction({ agentId: payload.agentId, sessionId: payload.sessionId }))
          navigate(payload.agentId === DEFAULT_OPENCODE_AGENT_ID ? '/new-assistant' : '/agents')
        }
      })
    }

    return window.electron.ipcRenderer.on(IpcChannel.Agent_ActionRequired, handleAgentActionRequired)
  }, [client, dispatch, navigate, t])

  return null
}

export default NavigationHandler
