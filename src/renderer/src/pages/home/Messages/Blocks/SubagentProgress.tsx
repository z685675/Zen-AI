import type { OpenCodeSubagentProgress } from '@shared/agents/opencodeSubagents'
import { AlertTriangle, CheckCircle2, LoaderCircle, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'

const statusLabels = {
  queued: 'nativeSubagents.queued',
  running: 'nativeSubagents.running',
  waiting_permission: 'nativeSubagents.waiting_permission',
  waiting_answer: 'nativeSubagents.waiting_answer',
  completed: 'nativeSubagents.completed',
  failed: 'nativeSubagents.failed',
  cancelled: 'nativeSubagents.cancelled'
} as const

export default function SubagentProgress({ tasks }: { tasks: OpenCodeSubagentProgress[] }) {
  const { t } = useTranslation()
  if (!tasks.length) return null
  return (
    <div className="border-(--zen-border) border-b py-1 text-xs" aria-label={t('nativeSubagents.title')}>
      <div className="flex items-center gap-2 py-1 font-medium">
        <Users size={13} />
        {t('nativeSubagents.title')} · {tasks.length}
      </div>
      {tasks.map((task) => {
        const terminal = ['completed', 'failed', 'cancelled'].includes(task.status)
        return (
          <div key={task.id} className="flex items-center gap-2 py-1">
            {task.status === 'completed' ? (
              <CheckCircle2 size={13} className="shrink-0 text-(--zen-success)!" />
            ) : task.status === 'failed' ? (
              <AlertTriangle size={13} className="shrink-0 text-(--zen-danger)!" />
            ) : terminal ? (
              <Users size={14} />
            ) : (
              <LoaderCircle size={13} className="shrink-0 text-(--zen-warning)! motion-safe:animate-spin" />
            )}
            <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
              <div className="truncate" title={task.description}>
                {task.description || t('nativeSubagents.title')}
              </div>
              <div className="shrink-0 text-(--zen-text-2) tabular-nums">
                {t(statusLabels[task.status])}
                {task.background ? ` · ${t('nativeSubagents.background')}` : ''}
                {task.toolCalls > 0 ? ` · ${t('nativeSubagents.tools', { count: task.toolCalls })}` : ''}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
