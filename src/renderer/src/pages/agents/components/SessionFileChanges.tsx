import { useTopicMessages } from '@renderer/hooks/useMessageOperations'
import { useArtifactAvailability } from '@renderer/pages/home/Messages/useArtifactAvailability'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import type { AssistantFileChange, AssistantFilePreview } from '@shared/agents/assistantFileChanges'
import { Alert, Button, Drawer, List, Modal, Popconfirm, Spin, Tag } from 'antd'
import { diffLines } from 'diff'
import { Files } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export default function SessionFileChanges({
  sessionId,
  topicId,
  running
}: {
  sessionId: string
  topicId: string
  running: boolean
}) {
  const { t, i18n } = useTranslation()
  const messages = useTopicMessages(topicId)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [records, setRecords] = useState<AssistantFileChange[]>([])
  const [restoring, setRestoring] = useState<string>()
  const [preview, setPreview] = useState<{
    record: AssistantFileChange
    value?: AssistantFilePreview
    loading?: boolean
  }>()
  const previewRequest = useRef(0)
  const { status, open: openFile } = useArtifactAvailability(records, open)
  const date = new Intl.DateTimeFormat(i18n.language || undefined, { dateStyle: 'short', timeStyle: 'medium' })
  const load = useCallback(async () => {
    setLoading(true)
    setLoadFailed(false)
    try {
      setRecords(await window.api.agentLifecycle.fileChanges(sessionId))
    } catch {
      setLoadFailed(true)
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    if (open && !running) void load()
  }, [open, running, load])

  const restore = async (record: AssistantFileChange) => {
    setRestoring(record.id)
    try {
      const result = await window.api.agentLifecycle.restoreFileChange(sessionId, record.id)
      if (result === 'restored') {
        window.toast.success(t('assistantFileChanges.restored'))
        await load()
      } else window.toast.warning(t(`assistantFileChanges.${result}`))
    } catch {
      window.toast.error(t('assistantFileChanges.unavailable'))
    } finally {
      setRestoring(undefined)
    }
  }

  const openPreview = async (record: AssistantFileChange) => {
    const request = ++previewRequest.current
    setPreview({ record, loading: true })
    const value = await window.api.agentLifecycle.previewFileChange(sessionId, record.id).catch(() => undefined)
    if (request === previewRequest.current) setPreview({ record, value })
  }

  return (
    <>
      <Button
        type="text"
        size="small"
        icon={<Files size={16} />}
        onClick={() => {
          setOpen(true)
          if (running) void load()
        }}>
        {t('assistantFileChanges.title')}
      </Button>
      <Drawer
        title={t('assistantFileChanges.title')}
        open={open}
        onClose={() => setOpen(false)}
        width="min(580px, 92vw)">
        <p className="mb-3 text-(--color-text-2) text-sm">{t('assistantFileChanges.description')}</p>
        {loadFailed && <Alert type="error" message={t('assistantFileChanges.loadFailed')} showIcon />}
        <Button size="small" loading={loading} onClick={() => void load()}>
          {t('common.refresh')}
        </Button>
        <List
          loading={loading}
          dataSource={records}
          rowKey="id"
          pagination={records.length > 15 ? { pageSize: 15, size: 'small', showSizeChanger: false } : false}
          locale={{ emptyText: t('assistantFileChanges.empty') }}
          renderItem={(record) => {
            const source = messages.find(
              (message) =>
                message.role === 'assistant' && message.providerMetadata?.opencode?.user_message_id === record.turn
            )
            return (
              <List.Item className="items-stretch! flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate font-medium">{record.path.split(/[\\/]/).at(-1)}</span>
                  <Tag>{t(`assistantFileChanges.${record.restoredAt ? 'restored' : record.kind}`)}</Tag>
                </div>
                <div className="break-all text-(--color-text-2) text-xs">{record.path}</div>
                <div className="text-(--color-text-2) text-xs">{date.format(record.changedAt)}</div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="small"
                    disabled={status(record.path) !== 'available'}
                    onClick={() => void openFile(record.path)}>
                    {t('assistantDeliverables.open')}
                  </Button>
                  <Button size="small" onClick={() => void openPreview(record)}>
                    {t('assistantFileChanges.preview')}
                  </Button>
                  {source && (
                    <Button
                      size="small"
                      onClick={() => {
                        setOpen(false)
                        void EventEmitter.emit(EVENT_NAMES.LOCATE_MESSAGE, { topicId, messageId: source.id })
                      }}>
                      {t('assistantDeliverables.locate')}
                    </Button>
                  )}
                  {record.canRestore && (
                    <Popconfirm
                      title={t(
                        record.kind === 'created' ? 'assistantFileChanges.confirmTrash' : 'assistantFileChanges.confirm'
                      )}
                      description={record.path}
                      disabled={running || !!restoring}
                      onConfirm={() => restore(record)}>
                      <Button size="small" disabled={running || !!restoring} loading={restoring === record.id}>
                        {t(
                          record.kind === 'created' ? 'assistantFileChanges.undoCreate' : 'assistantFileChanges.restore'
                        )}
                      </Button>
                    </Popconfirm>
                  )}
                </div>
              </List.Item>
            )
          }}
        />
      </Drawer>
      <Modal
        title={t('assistantFileChanges.preview')}
        open={!!preview}
        width="min(940px, 94vw)"
        footer={null}
        onCancel={() => {
          previewRequest.current++
          setPreview(undefined)
        }}>
        {preview && <p className="mb-3 break-all text-sm">{preview.record.path}</p>}
        {preview?.loading ? (
          <Spin />
        ) : preview?.value ? (
          <FilePreview value={preview.value} />
        ) : (
          <Alert type="warning" showIcon message={t('assistantFileChanges.loadFailed')} />
        )}
      </Modal>
    </>
  )
}

function FilePreview({ value }: { value: AssistantFilePreview }) {
  const { t } = useTranslation()
  const diff = useMemo(
    () =>
      value.format === 'metadata' ? undefined : diffLines(value.before ?? '', value.current ?? '', { timeout: 150 }),
    [value]
  )
  const size = (bytes: number | null) => (bytes === null ? '—' : t('assistantFileChanges.bytes', { count: bytes }))
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3 text-sm">
        <span>
          {t('assistantFileChanges.before')} · {size(value.beforeBytes)}
        </span>
        <span>
          {t('assistantFileChanges.current')} · {size(value.currentBytes)}
        </span>
      </div>
      {value.changedSince && <Alert type="warning" showIcon message={t('assistantFileChanges.previewConflict')} />}
      {value.format === 'document' && <p className="text-xs">{t('assistantFileChanges.previewDocument')}</p>}
      {value.partial && <p className="text-xs">{t('assistantFileChanges.previewPartial')}</p>}
      {value.format === 'metadata' ? (
        <p className="text-sm">{t('assistantFileChanges.previewMetadata')}</p>
      ) : diff ? (
        <pre className="max-h-[52vh] overflow-auto whitespace-pre-wrap break-all rounded border border-(--color-border) p-2 text-xs">
          {diff.map((part, index) => (
            <span key={index} className={part.added ? 'bg-green-500/15' : part.removed ? 'bg-red-500/15' : undefined}>
              {part.value
                .split(/(?<=\n)/)
                .filter(Boolean)
                .map((line) => `${part.added ? '+' : part.removed ? '-' : ' '} ${line}`)
                .join('')}
            </span>
          ))}
        </pre>
      ) : (
        <div className="grid max-h-[52vh] grid-cols-2 gap-3 overflow-auto text-xs">
          <pre className="whitespace-pre-wrap break-all">{value.before}</pre>
          <pre className="whitespace-pre-wrap break-all">{value.current}</pre>
        </div>
      )}
    </div>
  )
}
