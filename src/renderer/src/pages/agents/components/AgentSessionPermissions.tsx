import NarrowLayout from '@renderer/pages/home/Messages/NarrowLayout'
import { AskUserQuestionCard } from '@renderer/pages/home/Messages/Tools/AskUserQuestionCard'
import { useAgentToolApproval } from '@renderer/pages/home/Messages/Tools/hooks/useAgentToolApproval'
import ToolApprovalActions from '@renderer/pages/home/Messages/Tools/ToolApprovalActions'
import { useAppSelector } from '@renderer/store'
import type { ToolPermissionEntry } from '@renderer/store/toolPermissions'
import { Alert } from 'antd'
import { useTranslation } from 'react-i18next'

function SessionPermission({ request }: { request: ToolPermissionEntry }) {
  const { t } = useTranslation()
  const approval = useAgentToolApproval(null, { toolCallId: request.toolCallId, requestId: request.requestId })
  const loop = request.toolName === 'doom_loop'
  if (request.toolName === 'question')
    return (
      <AskUserQuestionCard
        toolResponse={{
          id: request.toolCallId,
          toolCallId: request.toolCallId,
          arguments: request.input,
          status: 'pending',
          tool: { id: 'question', name: 'question', description: t('agent.askUserQuestion.title'), type: 'provider' }
        }}
      />
    )
  return (
    <Alert
      type="warning"
      className="zen-session-permission"
      showIcon
      role="alert"
      message={t(loop ? 'new_assistant.permission.loopTitle' : 'new_assistant.permission.title')}
      description={
        <div className="flex flex-col gap-2">
          <span>{t(loop ? 'new_assistant.permission.loopDescription' : 'new_assistant.permission.description')}</span>
          <details open={!loop}>
            <summary>{t('new_assistant.permission.details')}</summary>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-(--zen-radius-sm) bg-(--zen-code-bg) p-2 font-mono text-xs">
              {request.inputPreview}
            </pre>
          </details>
          <ToolApprovalActions
            {...approval}
            confirmLabel={loop ? t('new_assistant.permission.loopAllow') : undefined}
            cancelLabel={loop ? t('new_assistant.permission.loopSkip') : undefined}
          />
        </div>
      }
    />
  )
}

/** Permissions such as doom_loop have no tool call. Keep an actionable entry outside the message scroll. */
export default function AgentSessionPermissions({ sessionId }: { sessionId: string }) {
  const requests: Record<string, ToolPermissionEntry> = useAppSelector((state) => state.toolPermissions?.requests ?? {})
  const pending = Object.values(requests)
    .filter((request) => request.status !== 'invoking' && request.toolCallId.startsWith(`${sessionId}:`))
    .sort((a, b) => a.createdAt - b.createdAt)
  if (!pending.length) return null
  return (
    <div className="max-h-72 shrink-0 overflow-auto py-2" data-session-permissions={sessionId}>
      <NarrowLayout reading>
        <div className="flex flex-col gap-2">
          {pending.map((request) => (
            <SessionPermission key={request.requestId} request={request} />
          ))}
        </div>
      </NarrowLayout>
    </div>
  )
}
