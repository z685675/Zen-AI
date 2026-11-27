import type { AgentEntity, AgentSessionEntity } from '@renderer/types'
import { cn } from '@renderer/utils'
import { formatErrorMessageWithPrefix } from '@renderer/utils/error'
import { Folder } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

type SessionWorkspaceMetaProps = {
  agent: AgentEntity
  session: AgentSessionEntity
}

const SessionWorkspaceMeta = ({ agent, session }: SessionWorkspaceMetaProps) => {
  const { t } = useTranslation()

  if (!session || !agent) {
    return null
  }

  const firstAccessiblePath = session.accessible_paths?.[0]

  const getLastFolderName = (path: string): string => {
    const trimmedPath = path.replace(/[/\\]+$/, '')
    const parts = trimmedPath.split(/[/\\]/)
    return parts[parts.length - 1] || path
  }

  const infoItems: ReactNode[] = []

  const InfoTag = ({
    text,
    tooltip,
    className,
    onClick
  }: {
    text: string
    tooltip?: string
    className?: string
    onClick?: (e: React.MouseEvent) => void
  }) => (
    <div
      className={cn(
        'nodrag flex h-[35px] items-center gap-1.5 rounded-full px-3 text-(--zen-text-2) text-xs transition-all',
        onClick !== undefined ? 'cursor-pointer hover:text-(--zen-text-1)' : undefined,
        className
      )}
      style={{
        background: 'var(--zen-glass-pill)',
        backdropFilter: 'blur(24px) saturate(160%)',
        boxShadow: 'var(--zen-shadow-pill)'
      }}
      title={tooltip ?? text}
      onClick={onClick}>
      <Folder className="h-3.5 w-3.5 shrink-0" />
      <span className="block truncate">{text}</span>
    </div>
  )

  if (firstAccessiblePath) {
    infoItems.push(
      <InfoTag
        key="path"
        text={getLastFolderName(firstAccessiblePath)}
        tooltip={firstAccessiblePath}
        className="max-w-44 transition-colors"
        onClick={() => {
          window.api.file
            .openPath(firstAccessiblePath)
            .catch((e) =>
              window.toast.error(
                formatErrorMessageWithPrefix(e, t('files.error.open_path', { path: firstAccessiblePath }))
              )
            )
        }}
      />
    )
  }

  if (infoItems.length === 0) {
    return null
  }

  return <div className="flex min-w-0 items-center gap-1.5">{infoItems}</div>
}

export default SessionWorkspaceMeta
