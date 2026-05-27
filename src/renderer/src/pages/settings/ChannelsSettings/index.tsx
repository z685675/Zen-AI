import ListItem from '@renderer/components/ListItem'
import Scrollbar from '@renderer/components/Scrollbar'
import { getChannelTypeIcon } from '@renderer/utils/agentSession'
import type { FC } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

import ChannelDetail from './ChannelDetail'
import { AVAILABLE_CHANNELS, type AvailableChannel } from './channelTypes'

const TITLE_STYLE = { fontWeight: 500 } as const

const ChannelsSettings: FC = () => {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedType = searchParams.get('type')
  const initialSelectedType = useMemo(
    () => AVAILABLE_CHANNELS.find((channel) => channel.type === requestedType) ?? AVAILABLE_CHANNELS[0],
    [requestedType]
  )
  const [selectedType, setSelectedType] = useState<AvailableChannel>(initialSelectedType)

  useEffect(() => {
    setSelectedType(initialSelectedType)
  }, [initialSelectedType])

  const handleSelectType = (channel: AvailableChannel) => {
    setSelectedType(channel)

    const nextParams = new URLSearchParams(searchParams)
    nextParams.set('type', channel.type)
    setSearchParams(nextParams, { replace: true })
  }

  return (
    <div className="flex flex-1">
      <div
        className="flex w-full flex-1 flex-row overflow-hidden"
        style={{ height: 'calc(100vh - var(--navbar-height) - 6px)' }}>
        <Scrollbar
          className="flex flex-col gap-1.25 border-(--color-border) border-r-[0.5px] p-3 pb-12"
          style={{ width: 'var(--settings-width)', height: 'calc(100vh - var(--navbar-height))' }}>
          {AVAILABLE_CHANNELS.map((ch) => {
            const iconSrc = getChannelTypeIcon(ch.type)
            return (
              <ListItem
                key={ch.type}
                title={t(ch.titleKey)}
                active={selectedType.type === ch.type}
                onClick={() => handleSelectType(ch)}
                icon={
                  iconSrc ? (
                    <img src={iconSrc} alt={ch.name} className="h-5.5 w-5.5 rounded object-contain" />
                  ) : undefined
                }
                subtitle={ch.available ? t(ch.description) : t('agent.cherryClaw.channels.comingSoon')}
                titleStyle={TITLE_STYLE}
              />
            )
          })}
        </Scrollbar>
        <div className="relative flex-1">
          <ChannelDetail key={selectedType.type} channelDef={selectedType} />
        </div>
      </div>
    </div>
  )
}

export default ChannelsSettings
