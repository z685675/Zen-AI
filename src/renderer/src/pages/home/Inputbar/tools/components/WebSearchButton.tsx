import { ActionIconButton } from '@renderer/components/Buttons'
import type { Topic } from '@renderer/types'
import { Tooltip } from 'antd'
import { Globe } from 'lucide-react'
import type { FC } from 'react'
import { memo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  topic: Topic
  onTopicChange: (topic: Topic) => void
}

const WebSearchButton: FC<Props> = ({ topic, onTopicChange }) => {
  const { t } = useTranslation()
  const enableWebSearch = topic.enableWebSearch === true

  const onClick = useCallback(() => {
    const nextEnabled = !enableWebSearch
    onTopicChange({
      ...topic,
      enableWebSearch: nextEnabled
    })
    window.toast.info(t(nextEnabled ? 'chat.input.web_search.toast_enabled' : 'chat.input.web_search.toast_disabled'))
  }, [enableWebSearch, onTopicChange, t, topic])

  const ariaLabel = t('chat.input.web_search.label')
  const tooltip = enableWebSearch ? t('chat.input.web_search.enabled') : t('chat.input.web_search.disabled')

  return (
    <Tooltip placement="top" title={tooltip} mouseLeaveDelay={0} arrow>
      <ActionIconButton
        onClick={onClick}
        active={!!enableWebSearch}
        aria-label={ariaLabel}
        aria-pressed={!!enableWebSearch}>
        <Globe className="icon" size={18} />
      </ActionIconButton>
    </Tooltip>
  )
}

export default memo(WebSearchButton)
