import { permissionModeCards } from '@renderer/config/agent'
import type { PermissionMode, UpdateAgentBaseForm } from '@renderer/types'
import { normalizePermissionMode } from '@renderer/types'
import { CheckCircle } from 'lucide-react'
import type { FC } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  type AgentOrSessionSettingsProps,
  defaultConfiguration,
  SettingsContainer,
  SettingsItem,
  SettingsTitle
} from '../shared'

export const PermissionModeSettings: FC<AgentOrSessionSettingsProps> = ({ agentBase, update }) => {
  const { t } = useTranslation()
  const [updating, setUpdating] = useState(false)
  const configuration = agentBase?.configuration ?? defaultConfiguration
  const selectedMode = normalizePermissionMode(configuration.permission_mode)

  const selectMode = async (nextMode: PermissionMode) => {
    if (!agentBase || nextMode === selectedMode || updating) return
    setUpdating(true)
    try {
      await update({
        id: agentBase.id,
        configuration: { ...configuration, permission_mode: nextMode }
      } satisfies UpdateAgentBaseForm)
    } finally {
      setUpdating(false)
    }
  }

  if (!agentBase) return null

  return (
    <SettingsContainer>
      <SettingsItem divider={false}>
        <SettingsTitle>{t('agent.settings.tooling.permissionMode.simpleTitle', 'Mode')}</SettingsTitle>
        <div className="mt-2 flex flex-col gap-3">
          {permissionModeCards.map((card) => {
            const selected = card.mode === selectedMode
            return (
              <button
                key={card.mode}
                type="button"
                aria-pressed={selected}
                disabled={updating}
                className={`flex items-start justify-between gap-3 rounded-lg border p-4 text-left transition-colors disabled:opacity-60 ${
                  selected
                    ? 'border-primary bg-primary-50/30 dark:bg-primary-950/20'
                    : 'border-default-200 hover:bg-default-50 dark:hover:bg-default-900/20'
                }`}
                onClick={() => void selectMode(card.mode)}>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="font-semibold text-sm">{t(card.titleKey, card.titleFallback)}</span>
                  <span className="text-[var(--color-text-2)] text-xs">
                    {t(card.descriptionKey, card.descriptionFallback)}
                  </span>
                </span>
                {selected && <CheckCircle className="shrink-0 text-primary" size={20} />}
              </button>
            )
          })}
        </div>
      </SettingsItem>
    </SettingsContainer>
  )
}

export default PermissionModeSettings
