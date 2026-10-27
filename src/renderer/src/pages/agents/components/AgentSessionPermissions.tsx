import NarrowLayout from '@renderer/pages/home/Messages/NarrowLayout'
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
  return (
    <Alert
      type="warning"
      showIcon
      role="alert"
      message={t(loop ? 'new_assistant.permission.loopTitle' : 'new_assistant.permission.title')}
      description={
        <div className="flex flex-col gap-2">
          <span>{t(loop ? 'new_assistant.permission.loopDescription' : 'new_assistant.permission.description')}</span>
          <details open={!loop}>
            <summary>{t('new_assistant.permission.details')}</summary>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all">{request.inputPreview}</pre>
          </details>
          <ToolApprovalActions {...approval} />
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
    <div className="max-h-72 shrink-0 overflow-auto px-4.5 py-2" data-session-permissions={sessionId}>
      <NarrowLayout contentMaxWidth="960px">
        <div className="flex flex-col gap-2">
          {pending.map((request) => (
            <SessionPermission key={request.requestId} request={request} />
          ))}
        </div>
      </NarrowLayout>
    </div>
  )
}
