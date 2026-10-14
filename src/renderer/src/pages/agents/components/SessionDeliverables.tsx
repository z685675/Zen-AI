import { useTopicMessages } from '@renderer/hooks/useMessageOperations'
import { collectSessionArtifacts, localArtifactKey } from '@renderer/pages/home/Messages/artifactShortcuts'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { useAppSelector } from '@renderer/store'
import { Button, Drawer, Empty, Input, List } from 'antd'
import { FileText, FolderOpen, PackageOpen } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { shallowEqual } from 'react-redux'

export default function SessionDeliverables({ topicId }: { topicId: string }) {
  const { t } = useTranslation()
  const messages = useTopicMessages(topicId)
  const blocks = useAppSelector(
    (state) => messages.flatMap((message) => message.blocks.map((id) => state.messageBlocks.entities[id])),
    shallowEqual
  )
  const artifacts = useMemo(
    () =>
      collectSessionArtifacts(
        messages,
        Object.fromEntries(blocks.filter((block) => !!block).map((block) => [block.id, block]))
      ),
    [messages, blocks]
  )
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const filtered = artifacts.filter((item) => item.path.toLowerCase().includes(query.trim().toLowerCase()))
  const openPath = (path: string, reveal: boolean) => {
    const operation = reveal ? window.api.file.showInFolder(path) : window.api.file.openPath(path)
    void operation.catch(() => window.toast.error(t('chat.input.tools.open_file_error', { path })))
  }
  return (
    <>
      <Button type="text" size="small" icon={<PackageOpen size={16} />} onClick={() => setOpen(true)}>
        {t('assistantDeliverables.entry', { count: artifacts.length })}
      </Button>
      <Drawer
        title={t('assistantDeliverables.title')}
        open={open}
        onClose={() => setOpen(false)}
        width="min(520px, 90vw)"
        destroyOnHidden>
        <p className="text-(--color-text-2) text-xs">{t('assistantDeliverables.notice')}</p>
        <Input.Search
          aria-label={t('assistantDeliverables.search')}
          placeholder={t('assistantDeliverables.search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          allowClear
        />
        <List
          dataSource={filtered}
          rowKey={(item) => localArtifactKey(item.path)}
          pagination={filtered.length > 15 ? { pageSize: 15, size: 'small', showSizeChanger: false } : false}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={t(artifacts.length ? 'assistantDeliverables.no_match' : 'assistantDeliverables.empty')}
              />
            )
          }}
          renderItem={(item) => {
            const name = item.path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? item.path
            return (
              <List.Item className="items-stretch! flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  {item.kind === 'directory' ? <FolderOpen size={16} /> : <FileText size={16} />}
                  <span className="min-w-0 flex-1 truncate" title={name}>
                    {name}
                  </span>
                  <span className="text-(--color-text-2) text-xs">
                    {item.kind === 'directory' ? t('assistantDeliverables.folder') : item.format?.toUpperCase()}
                  </span>
                </div>
                <div className="break-all text-(--color-text-2) text-xs">{item.path}</div>
                <div className="text-(--color-text-2) text-xs">
                  {t('assistantDeliverables.source', { turn: item.turn, count: item.occurrences })}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="small" onClick={() => openPath(item.path, false)}>
                    {t('assistantDeliverables.open')}
                  </Button>
                  {item.kind !== 'directory' && (
                    <Button size="small" onClick={() => openPath(item.path, true)}>
                      {t('assistantDeliverables.reveal')}
                    </Button>
                  )}
                  <Button
                    size="small"
                    onClick={() => {
                      setOpen(false)
                      void EventEmitter.emit(EVENT_NAMES.LOCATE_MESSAGE, { topicId, messageId: item.messageId })
                    }}>
                    {t('assistantDeliverables.locate')}
                  </Button>
                </div>
              </List.Item>
            )
          }}
        />
      </Drawer>
    </>
  )
}
