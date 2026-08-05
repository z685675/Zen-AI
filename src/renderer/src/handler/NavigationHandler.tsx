import { useAppDispatch, useAppSelector } from '@renderer/store'
import { setActiveAgentId, setActiveSessionIdAction } from '@renderer/store/runtime'
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
    const handleAgentActionRequired = (_event: Electron.IpcRendererEvent, payload: AgentActionRequiredPayload) => {
      window.modal.confirm({
        centered: true,
        icon: <AlertCircle size={22} color="var(--color-warning)" />,
        title: t('agent.actionRequired.title'),
        content: payload.message,
        okText: t('agent.actionRequired.open'),
        cancelText: t('agent.actionRequired.later'),
        onOk: () => {
          window.dispatchEvent(new Event('zen-ai:close-agent-quick-entry'))
          dispatch(setActiveAgentId(payload.agentId))
          dispatch(setActiveSessionIdAction({ agentId: payload.agentId, sessionId: payload.sessionId }))
          navigate('/agents')
        }
      })
    }

    return window.electron.ipcRenderer.on(IpcChannel.Agent_ActionRequired, handleAgentActionRequired)
  }, [dispatch, navigate, t])

  return null
}

export default NavigationHandler
