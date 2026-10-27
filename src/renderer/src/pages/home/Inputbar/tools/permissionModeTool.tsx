import { permissionModeCards } from '@renderer/config/agent'
import { useActiveSession } from '@renderer/hooks/agents/useActiveSession'
import { useUpdateSession } from '@renderer/hooks/agents/useUpdateSession'
import type { PermissionMode } from '@renderer/types'
import { AgentConfigurationSchema, normalizePermissionMode } from '@renderer/types'
import { Tooltip } from 'antd'
import { FileEdit, Lightbulb } from 'lucide-react'
import { useState } from 'react'
import styled from 'styled-components'

import { defineTool, registerTool, TopicType } from '../types'

const permissionModeTool = defineTool({
  key: 'permission_mode',
  label: (t) => t('agent.settings.tooling.permissionMode.simpleTitle', 'Mode'),
  visibleInScopes: [TopicType.Session],

  render: function PermissionModeRender(context) {
    const { t, session: sessionContext } = context
    const { session } = useActiveSession()
    const { updateSession } = useUpdateSession(sessionContext?.agentId ?? null)
    const [updating, setUpdating] = useState(false)
    const currentMode = normalizePermissionMode(session?.configuration?.permission_mode)

    const selectMode = async (nextMode: PermissionMode) => {
      if (!session || updating || nextMode === currentMode) return
      setUpdating(true)
      try {
        // OpenCode uses native Plan/Build permissions, not the old SDK's
        // allowed_tools list. Changing a session must not alter agent defaults.
        await updateSession(
          {
            id: session.id,
            configuration: AgentConfigurationSchema.parse({ ...session.configuration, permission_mode: nextMode })
          },
          { showSuccessToast: false }
        )
      } finally {
        setUpdating(false)
      }
    }

    return (
      <ModeGroup role="group" aria-label={t('agent.settings.tooling.permissionMode.simpleTitle', 'Mode')}>
        {permissionModeCards.map((card) => (
          <Tooltip key={card.mode} title={t(card.descriptionKey, card.descriptionFallback)}>
            <ModeButton
              type="button"
              aria-pressed={currentMode === card.mode}
              $selected={currentMode === card.mode}
              disabled={!session || updating}
              onClick={() => void selectMode(card.mode)}>
              {card.mode === 'plan' ? <Lightbulb size={14} /> : <FileEdit size={14} />}
              {t(card.titleKey, card.titleFallback)}
            </ModeButton>
          </Tooltip>
        ))}
      </ModeGroup>
    )
  }
})

const ModeGroup = styled.div`
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-background-soft);
`

const ModeButton = styled.button<{ $selected: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: 999px;
  background: ${({ $selected }) => ($selected ? 'var(--color-background)' : 'transparent')};
  color: ${({ $selected }) => ($selected ? 'var(--color-primary)' : 'var(--color-text-2)')};
  font-size: 12px;
  font-weight: ${({ $selected }) => ($selected ? 600 : 400)};
  white-space: nowrap;
  cursor: pointer;

  &:hover:not(:disabled) {
    color: var(--color-primary);
  }

  &:disabled {
    cursor: default;
    opacity: 0.6;
  }
`

registerTool(permissionModeTool)

export default permissionModeTool
