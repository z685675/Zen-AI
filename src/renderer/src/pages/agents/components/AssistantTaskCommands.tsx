import { assistantTaskCommands } from '@renderer/utils/assistantTaskCommands'
import { Dropdown } from 'antd'
import { Command } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

export default function AssistantTaskCommands({ onSelect }: { onSelect: (command: string) => void }) {
  const { t } = useTranslation()
  const [phrases, setPhrases] = useState<Array<{ title: string; content: string }>>([])
  const commands = [...assistantTaskCommands(t, phrases).values()]
  return (
    <Dropdown
      trigger={['click']}
      placement="topLeft"
      onOpenChange={(open) => {
        if (open)
          void import('@renderer/services/QuickPhraseService')
            .then(({ default: service }) => service.getAll().then(setPhrases))
            .catch(() => undefined)
      }}
      menu={{
        items: [
          ...commands.map(({ id, label }) => ({ key: id, label: label === `/${id}` ? label : `/${id} · ${label}` })),
          { type: 'divider' },
          { key: '', disabled: true, label: t('assistantTaskCommands.customHint') }
        ],
        onClick: ({ key }) => onSelect(`/${key}`)
      }}>
      <button
        type="button"
        aria-label={t('assistantTaskCommands.title')}
        title={t('assistantTaskCommands.title')}
        className="flex h-7 items-center gap-1 rounded-(--zen-radius-sm) border border-(--zen-border) bg-(--zen-bg-subtle) px-2 text-(--zen-text-2) text-xs hover:bg-(--zen-bg-hover)">
        <Command size={13} />
        <span aria-hidden="true">/</span>
      </button>
    </Dropdown>
  )
}
