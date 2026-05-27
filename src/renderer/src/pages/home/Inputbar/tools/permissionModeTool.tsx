import { permissionModeCards } from '@renderer/config/agent'
import { useActiveSession } from '@renderer/hooks/agents/useActiveSession'
import { useAgent } from '@renderer/hooks/agents/useAgent'
import { useUpdateAgent } from '@renderer/hooks/agents/useUpdateAgent'
import { useUpdateSession } from '@renderer/hooks/agents/useUpdateSession'
import { computeModeDefaults, defaultConfiguration } from '@renderer/pages/settings/AgentSettings/shared'
import type { PermissionMode } from '@renderer/types'
import { normalizePermissionMode } from '@renderer/types'
import { Popover } from 'antd'
import { uniq } from 'lodash'
import { ChevronDown, FileEdit, Lightbulb, RefreshCcw } from 'lucide-react'
import type { ReactNode } from 'react'
import { useCallback, useMemo, useState } from 'react'
import styled from 'styled-components'

import { defineTool, registerTool, TopicType } from '../types'

const getPermissionModeIcon = (mode: PermissionMode): ReactNode => {
  switch (normalizePermissionMode(mode)) {
    case 'plan':
      return <Lightbulb size={18} color="#faad14" />
    case 'acceptEdits':
      return <FileEdit size={18} color="#52c41a" />
    case 'bypassPermissions':
      return <RefreshCcw size={18} color="#722ed1" />
    default:
      return <FileEdit size={18} color="#52c41a" />
  }
}

const permissionModeTool = defineTool({
  key: 'permission_mode',
  label: (t) => t('agent.settings.permissionMode.currentModePrefix', 'Current Mode:'),
  visibleInScopes: [TopicType.Session],

  render: function PermissionModeRender(context) {
    const { t, session: sessionContext } = context
    const agentId = sessionContext?.agentId
    const { session } = useActiveSession()
    const { agent } = useAgent(agentId ?? '')
    const { updateAgent } = useUpdateAgent()
    const { updateSession } = useUpdateSession(agentId ?? null)
    const [open, setOpen] = useState(false)

    const currentMode = normalizePermissionMode(session?.configuration?.permission_mode ?? 'default')
    const availableTools = useMemo(() => session?.tools ?? [], [session?.tools])

    const handleSelectMode = useCallback(
      (nextMode: PermissionMode) => {
        if (!session || nextMode === currentMode) {
          setOpen(false)
          return
        }

        const configuration = session.configuration ?? defaultConfiguration
        const currentAutoToolIds = computeModeDefaults(currentMode, availableTools)
        const nextAutoToolIds = computeModeDefaults(nextMode, availableTools)

        const currentAllowed = session.allowed_tools ?? []
        const userAddedIds = currentAllowed.filter((id) => !currentAutoToolIds.includes(id))
        const mergedAllowed = uniq([...nextAutoToolIds, ...userAddedIds])

        const updatedConfiguration = { ...configuration, permission_mode: nextMode }

        if (nextMode !== 'bypassPermissions' && agentId && agent?.configuration?.soul_enabled === true) {
          updatedConfiguration.soul_enabled = false
          void updateAgent(
            {
              id: agentId,
              configuration: { ...agent.configuration, soul_enabled: false, permission_mode: nextMode }
            },
            { showSuccessToast: false }
          )
        }

        void updateSession(
          {
            id: session.id,
            configuration: updatedConfiguration,
            allowed_tools: mergedAllowed
          },
          { showSuccessToast: false }
        )

        setOpen(false)
      },
      [agent, agentId, availableTools, currentMode, session, updateAgent, updateSession]
    )

    const modeCard = permissionModeCards.find((card) => card.mode === currentMode)
    const currentModeText = modeCard ? t(modeCard.titleKey, modeCard.titleFallback) : ''

    const popoverContent = (
      <ModeMenu>
        {permissionModeCards.map((card) => {
          const selected = card.mode === currentMode

          return (
            <ModeOption
              key={card.mode}
              type="button"
              $selected={selected}
              onClick={() => handleSelectMode(card.mode)}>
              <ModeOptionIcon $selected={selected}>{getPermissionModeIcon(card.mode)}</ModeOptionIcon>
              <ModeOptionBody>
                <ModeOptionTitleRow>
                  <ModeOptionTitle>{t(card.titleKey, card.titleFallback)}</ModeOptionTitle>
                  {card.caution && <ModeOptionBadge>高权限</ModeOptionBadge>}
                </ModeOptionTitleRow>
                <ModeOptionDescription>{t(card.descriptionKey, card.descriptionFallback)}</ModeOptionDescription>
              </ModeOptionBody>
            </ModeOption>
          )
        })}
      </ModeMenu>
    )

    return (
      <Popover
        trigger="click"
        placement="bottomLeft"
        open={open}
        onOpenChange={setOpen}
        content={popoverContent}
        arrow={false}
        overlayStyle={{ paddingTop: 8, zIndex: 1400 }}
        destroyOnHidden>
        <ModeButton type="button">
          <ModeIcon>{getPermissionModeIcon(currentMode)}</ModeIcon>
          <ModeText>
            {t('agent.settings.permissionMode.currentModePrefix', 'Current Mode:')}
            {currentModeText}
          </ModeText>
          <ChevronDown size={14} />
        </ModeButton>
      </Popover>
    )
  }
})

const ModeButton = styled.button`
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  gap: 6px;
  height: 34px;
  padding: 0 11px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-background);
  color: var(--color-text);
  font-size: 12px;
  transition:
    border-color 0.18s ease,
    background-color 0.18s ease,
    box-shadow 0.18s ease;

  &:hover {
    background: var(--color-background-soft);
    border-color: var(--color-primary-soft);
    box-shadow: 0 4px 10px rgba(15, 23, 42, 0.06);
  }
`

const ModeIcon = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
`

const ModeText = styled.span`
  white-space: nowrap;
  font-weight: 500;
`

const ModeMenu = styled.div`
  width: 320px;
  padding: 6px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.98);
  box-shadow:
    0 18px 40px rgba(15, 23, 42, 0.14),
    0 2px 10px rgba(15, 23, 42, 0.06);
  backdrop-filter: blur(18px);
`

const ModeOption = styled.button<{ $selected: boolean }>`
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 13px;
  border: 0;
  border-radius: 14px;
  background: ${(props) =>
    props.$selected
      ? 'linear-gradient(135deg, rgba(255, 244, 246, 0.98), rgba(255, 248, 237, 0.98))'
      : 'transparent'};
  text-align: left;
  transition:
    background-color 0.18s ease,
    transform 0.18s ease,
    box-shadow 0.18s ease;

  &:hover {
    background: ${(props) =>
      props.$selected
        ? 'linear-gradient(135deg, rgba(255, 241, 244, 1), rgba(255, 246, 232, 1))'
        : 'rgba(248, 250, 252, 0.92)'};
    box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.04);
  }
`

const ModeOptionIcon = styled.span<{ $selected: boolean }>`
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 1px;
  border-radius: 11px;
  background: ${(props) => (props.$selected ? 'rgba(255, 255, 255, 0.96)' : 'rgba(248, 250, 252, 0.96)')};
  box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.04);
`

const ModeOptionBody = styled.div`
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
`

const ModeOptionTitleRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
`

const ModeOptionTitle = styled.div`
  font-size: 15px;
  line-height: 1.35;
  font-weight: 600;
  color: var(--color-text);
`

const ModeOptionDescription = styled.div`
  font-size: 13px;
  line-height: 1.55;
  color: var(--color-text-secondary);
`

const ModeOptionBadge = styled.span`
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 7px;
  border-radius: 999px;
  background: rgba(255, 234, 238, 0.96);
  color: #c2415b;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
`

registerTool(permissionModeTool)

export default permissionModeTool
