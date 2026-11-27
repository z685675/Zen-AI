import { useTopicMessages } from '@renderer/hooks/useMessageOperations'
import { useArtifactAvailability } from '@renderer/pages/home/Messages/useArtifactAvailability'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import type { AssistantFileChange, AssistantFilePreview } from '@shared/agents/assistantFileChanges'
import { Alert, Button, Drawer, List, Modal, Popconfirm, Spin, Tag } from 'antd'
import { diffLines } from 'diff'
import { Files } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

type LineCounts = { added: number; removed: number }
const changesPerPage = 15
const textExtension =
  /\.(?:txt|mdx?|csv|tsv|jsonl?|ya?ml|toml|xml|tsx?|jsx?|py|sql|sh|ps1|html?|css|scss|java|go|rs|cs|c|h|cpp|hpp|rb|php|vue|svelte|ini|env|log)$/i
const changeLabels = {
  restored: 'assistantFileChanges.restored',
  created: 'assistantFileChanges.created',
  modified: 'assistantFileChanges.modified',
  deleted: 'assistantFileChanges.deleted'
} as const
const restoreErrors = {
  conflict: 'assistantFileChanges.conflict',
  unavailable: 'assistantFileChanges.unavailable',
  busy: 'assistantFileChanges.busy'
} as const

function fileDiff(value: AssistantFilePreview) {
  return value.format === 'metadata' ? undefined : diffLines(value.before ?? '', value.current ?? '', { timeout: 150 })
}

function countLines(value?: AssistantFilePreview) {
  if (!value || value.partial || value.changedSince) return undefined
  return fileDiff(value)?.reduce(
    (counts, part) => ({
      added: counts.added + (part.added ? part.count : 0),
      removed: counts.removed + (part.removed ? part.count : 0)
    }),
    { added: 0, removed: 0 }
  )
}

function DiffCounts({ counts }: { counts: LineCounts }) {
  return (
    <span className="inline-flex shrink-0 gap-1 font-mono text-xs tabular-nums">
      <span className="rounded bg-(--zen-accent-soft) px-1.5 text-(--zen-success)">+{counts.added}</span>
      <span className="rounded bg-(--zen-accent-soft) px-1.5 text-(--zen-danger)">−{counts.removed}</span>
    </span>
  )
}

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
  const [lineCounts, setLineCounts] = useState<Partial<Record<string, LineCounts>>>({})
  const [page, setPage] = useState(1)
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
      const nextRecords = await window.api.agentLifecycle.fileChanges(sessionId)
      setRecords(nextRecords)
      setPage((current) => Math.max(1, Math.min(current, Math.ceil(nextRecords.length / changesPerPage))))
    } catch {
      setLoadFailed(true)
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    void load()
  }, [running, load])

  useEffect(() => {
    if (!open || running || !window.api.agentLifecycle.previewFileChange) return
    let cancelled = false
    const visible = records.slice((page - 1) * changesPerPage, page * changesPerPage)
    const queue = visible.filter((record) => !record.restoredAt && textExtension.test(record.path))
    const loadNext = async () => {
      while (!cancelled) {
        const record = queue.shift()
        if (!record) return
        const result = await window.api.agentLifecycle.previewFileChange(sessionId, record.id).catch(() => undefined)
        if (cancelled) return
        const counts = countLines(result)
        if (counts) setLineCounts((previous) => ({ ...previous, [record.id]: counts }))
      }
    }
    void Promise.all([loadNext(), loadNext(), loadNext()])
    return () => {
      cancelled = true
    }
  }, [open, page, records, running, sessionId])

  const restore = async (record: AssistantFileChange) => {
    setRestoring(record.id)
    try {
      const result = await window.api.agentLifecycle.restoreFileChange(sessionId, record.id)
      if (result === 'restored') {
        setLineCounts((previous) => ({ ...previous, [record.id]: undefined }))
        window.toast.success(t('assistantFileChanges.restored'))
        await load()
      } else window.toast.warning(t(restoreErrors[result]))
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
    if (request !== previewRequest.current) return
    setPreview({ record, value })
    const counts = countLines(value)
    if (counts) setLineCounts((previous) => ({ ...previous, [record.id]: counts }))
  }

  if (records.length === 0 && !loadFailed && !open && !preview) return null

  return (
    <>
      {(records.length > 0 || loadFailed) && (
        <Button
          type="text"
          size="small"
          aria-label={t('assistantFileChanges.title')}
          title={t('assistantFileChanges.title')}
          icon={<Files size={16} />}
          onClick={() => {
            setOpen(true)
            if (!loadFailed) void load()
          }}>
          <span>{t('assistantFileChanges.title')}</span>
          {records.length > 0 && <span className="ml-1 font-mono tabular-nums">· {records.length}</span>}
        </Button>
      )}
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
          pagination={
            records.length > changesPerPage
              ? { current: page, onChange: setPage, pageSize: changesPerPage, size: 'small', showSizeChanger: false }
              : false
          }
          locale={{ emptyText: t('assistantFileChanges.empty') }}
          renderItem={(record) => {
            const source = messages.find(
              (message) =>
                message.role === 'assistant' && message.providerMetadata?.opencode?.user_message_id === record.turn
            )
            const counts = record.restoredAt ? undefined : lineCounts[record.id]
            return (
              <List.Item className="items-stretch! flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 break-all font-mono text-xs" title={record.path}>
                    {record.path}
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    {counts && <DiffCounts counts={counts} />}
                    <Tag>{t(changeLabels[record.restoredAt ? 'restored' : record.kind])}</Tag>
                  </div>
                </div>
                <div className="font-mono text-(--zen-text-2) text-xs tabular-nums">
                  {date.format(record.changedAt)}
                </div>
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
        {preview && <p className="mb-3 break-all font-mono text-sm">{preview.record.path}</p>}
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
  const diff = useMemo(() => fileDiff(value), [value])
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
        <DiffPreview diff={diff} />
      ) : (
        <div className="grid max-h-[52vh] grid-cols-2 gap-3 overflow-auto rounded-(--zen-radius-md) bg-(--zen-code-bg) p-2 font-mono text-xs">
          <pre className="whitespace-pre-wrap break-all">{value.before}</pre>
          <pre className="whitespace-pre-wrap break-all">{value.current}</pre>
        </div>
      )}
    </div>
  )
}

function DiffPreview({ diff }: { diff: NonNullable<ReturnType<typeof fileDiff>> }) {
  let before = 0
  let after = 0
  return (
    <div className="max-h-[52vh] overflow-auto rounded-(--zen-radius-md) border border-(--zen-border) bg-(--zen-code-bg) font-mono text-xs tabular-nums leading-[1.6]">
      {diff.flatMap((part) =>
        part.value
          .split(/(?<=\n)/)
          .filter(Boolean)
          .map((line) => {
            const left = part.added ? '' : ++before
            const right = part.removed ? '' : ++after
            const mark = part.added ? '+' : part.removed ? '−' : ' '
            return (
              <div
                key={`${left}:${right}`}
                className="grid grid-cols-[4ch_4ch_2ch_minmax(0,1fr)] px-2"
                style={{
                  background: part.added
                    ? 'color-mix(in srgb, var(--zen-success) 14%, transparent)'
                    : part.removed
                      ? 'color-mix(in srgb, var(--zen-danger) 14%, transparent)'
                      : undefined
                }}>
                <span aria-hidden="true" className="text-(--zen-text-3)">
                  {left}
                </span>
                <span aria-hidden="true" className="text-(--zen-text-3)">
                  {right}
                </span>
                <span aria-hidden="true" className={part.added ? 'text-(--zen-success)' : 'text-(--zen-danger)'}>
                  {mark}
                </span>
                <code className="whitespace-pre-wrap break-all">{line.replace(/\r?\n$/, '') || ' '}</code>
              </div>
            )
          })
      )}
    </div>
  )
}
