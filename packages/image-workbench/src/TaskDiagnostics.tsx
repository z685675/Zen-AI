import type { ImageCanvasTask } from '@shared/config/imageCanvas'
import { useTranslation } from 'react-i18next'

export function TaskDiagnostics({ task }: { task: ImageCanvasTask }) {
  const { t } = useTranslation()
  const diagnostics = task.diagnostics
  if (!diagnostics) return null
  const durations = Object.entries(diagnostics.phaseDurationsMs)
  const seconds = (ms: number) => (ms / 1000).toFixed(1)
  return (
    <details className="task-diagnostics">
      <summary>
        {t('diagnostics')} · {t('activeDuration', { seconds: seconds(durations.reduce((sum, [, ms]) => sum + ms, 0)) })}
      </summary>
      {diagnostics.failedPhase && <p>{t('failureStage', { phase: t(diagnostics.failedPhase) })}</p>}
      <p>{t('attempts', { count: diagnostics.attempts })}</p>
      <dl>
        {task.outputSizes?.length ? (
          <div>
            <dt>{t('outputSizes')}</dt>
            <dd>{task.outputSizes.join(', ')}</dd>
          </div>
        ) : null}
        {durations.map(([phase, ms]) => (
          <div key={phase}>
            <dt>{t(phase)}</dt>
            <dd>{seconds(ms)} s</dd>
          </div>
        ))}
        <div>
          <dt>{t('protocol')}</dt>
          <dd>{diagnostics.protocol}</dd>
        </div>
        <div>
          <dt>{t('capabilityRevision')}</dt>
          <dd>{diagnostics.capabilityRevision}</dd>
        </div>
        <div>
          <dt>{t('taskId')}</dt>
          <dd>{task.id}</dd>
        </div>
      </dl>
      {diagnostics.server && (
        <>
          <p>{t('serverTimingsHint')}</p>
          <dl>
            {Object.entries(diagnostics.server.phaseDurationsMs).map(([phase, ms]) => (
              <div key={phase}>
                <dt>{t('server_' + phase)}</dt>
                <dd>{seconds(ms)} s</dd>
              </div>
            ))}
            <div>
              <dt>{t('serverTaskId')}</dt>
              <dd>{diagnostics.server.jobId}</dd>
            </div>
            {diagnostics.server.httpStatus && (
              <div>
                <dt>HTTP</dt>
                <dd>{diagnostics.server.httpStatus}</dd>
              </div>
            )}
            {diagnostics.server.errorCode && (
              <div>
                <dt>{t('errorCode')}</dt>
                <dd>{diagnostics.server.errorCode}</dd>
              </div>
            )}
          </dl>
        </>
      )}
    </details>
  )
}
