import { EmojiAvatarWithPicker } from '@renderer/components/Avatar/EmojiAvatarWithPicker'
import type { AgentBaseWithId, UpdateAgentBaseForm, UpdateAgentFunctionUnion } from '@renderer/types'
import { AgentConfigurationSchema, isAgentEntity, isAgentType } from '@renderer/types'
import { getAgentAvatar } from '@shared/config/agents'
import { Input } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SettingsItem, SettingsTitle } from '../shared'

export interface NameSettingsProps {
  base: AgentBaseWithId | undefined | null
  update: UpdateAgentFunctionUnion
}

export const NameSetting = ({ base, update }: NameSettingsProps) => {
  const { t } = useTranslation()
  const [name, setName] = useState<string | undefined>(base?.name?.trim())

  const updateName = async (name: UpdateAgentBaseForm['name']) => {
    if (!base) return
    return update({ id: base.id, name: name?.trim() })
  }

  const isAgent = isAgentEntity(base)
  const isDefault = isAgent ? isAgentType(base.configuration?.avatar) : false
  const fallbackEmoji = isAgent && base ? getAgentAvatar(base.id, base.configuration?.avatar) : '🩶'
  const [emoji, setEmoji] = useState(isAgent && !isDefault ? fallbackEmoji : fallbackEmoji)

  useEffect(() => {
    setName(base?.name?.trim())
  }, [base?.id, base?.name])

  useEffect(() => {
    setEmoji(fallbackEmoji)
  }, [fallbackEmoji])

  const updateAvatar = useCallback(
    (avatar: string) => {
      if (!isAgent || !base) return
      const parsedConfiguration = AgentConfigurationSchema.parse(base.configuration ?? {})
      const payload = {
        id: base.id,
        configuration: {
          ...parsedConfiguration,
          avatar
        }
      }
      void update(payload)
    },
    [base, update, isAgent]
  )

  if (!base) return null

  return (
    <>
      {isAgent && (
        <SettingsItem inline>
          <SettingsTitle>{t('common.avatar')}</SettingsTitle>
          <EmojiAvatarWithPicker
            emoji={emoji}
            onPick={(nextEmoji: string) => {
              setEmoji(nextEmoji)
              if (isAgent && nextEmoji === base?.configuration?.avatar) return
              updateAvatar(nextEmoji)
            }}
          />
        </SettingsItem>
      )}
      <SettingsItem inline>
        <SettingsTitle>{t('common.name')}</SettingsTitle>
        <div className="relative flex flex-1 justify-end">
          <span className="invisible whitespace-pre px-[11px] py-1">
            {name || t('common.agent_one') + t('common.name')}
          </span>
          <Input
            placeholder={t('common.agent_one') + t('common.name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              if (name !== base.name) {
                void updateName(name)
              }
            }}
            className="absolute right-0"
            style={{ width: '100%', maxWidth: 'fit-content', textAlign: 'center' }}
          />
        </div>
      </SettingsItem>
    </>
  )
}
