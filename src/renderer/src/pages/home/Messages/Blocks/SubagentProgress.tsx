import type { OpenCodeSubagentProgress } from '@shared/agents/opencodeSubagents'
import { AlertTriangle, CheckCircle2, LoaderCircle, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export default function SubagentProgress({ tasks }: { tasks: OpenCodeSubagentProgress[] }) {
  const { t } = useTranslation()
  if (!tasks.length) return null
  return (
    <div
      className="my-2 space-y-2 rounded-lg border border-(--color-border) p-3 text-xs"
      aria-label={t('nativeSubagents.title')}>
      <div className="flex items-center gap-2 font-medium">
        <Users size={14} />
        {t('nativeSubagents.title')} · {tasks.length}
      </div>
      {tasks.map((task) => {
        const terminal = ['completed', 'failed', 'cancelled'].includes(task.status)
        return (
          <div key={task.id} className="flex items-start gap-2">
            {task.status === 'completed' ? (
              <CheckCircle2 size={14} />
            ) : task.status === 'failed' ? (
              <AlertTriangle size={14} />
            ) : terminal ? (
              <Users size={14} />
            ) : (
              <LoaderCircle size={14} className="animate-spin" />
            )}
            <div className="min-w-0 flex-1">
              <div className="break-words">{task.description || t('nativeSubagents.title')}</div>
              <div className="mt-1 text-(--color-text-3)">
                {t(`nativeSubagents.${task.status}`)}
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
