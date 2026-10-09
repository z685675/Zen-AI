import { isProd } from '@renderer/config/constant'
import { getDiagnosticEvidence, recordDiagnostic } from '@renderer/services/DiagnosticEvidenceService'
import { useAppSelector } from '@renderer/store'
import { isAgentSessionTopicId } from '@renderer/utils/agentSession'
import { diagnoseClientError } from '@renderer/utils/clientErrorDiagnosis'
import { classifyError } from '@renderer/utils/errorClassifier'
import { Alert, Button } from 'antd'
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  messageId?: string
  fallback?: React.ReactNode
  children: React.ReactNode
}

interface State {
  hasError: boolean
  error?: Error
}

const ErrorFallback = ({
  fallback,
  error,
  messageId
}: {
  fallback?: React.ReactNode
  error?: Error
  messageId?: string
}) => {
  const { t } = useTranslation()
  const [exporting, setExporting] = useState(false)
  const message = useAppSelector((state) => (messageId ? state.messages.entities[messageId] : undefined))
  const relatedUserMessage = useAppSelector((state) =>
    message?.askId ? state.messages.entities[message.askId] : undefined
  )
  const blockEntities = useAppSelector((state) => state.messageBlocks.entities)
  const exportPackage = async () => {
    if (!message || !error) return
    setExporting(true)
    try {
      const { exportErrorDiagnosticPackage, getDiagnosticAppInfo } = await import(
        '@renderer/services/ErrorDiagnosticPackageService'
      )
      const serialized = { name: error.name, message: error.message, stack: error.stack ?? null }
      const diagnosis = diagnoseClientError(serialized, {
        messageId: message.id,
        createdAt: message.createdAt,
        model: message.model
      })
      const savedPath = await exportErrorDiagnosticPackage({
        source: isAgentSessionTopicId(message.topicId) ? 'agent' : 'chat',
        title: t('error.render.title'),
        description: t('error.render.description'),
        classification: classifyError(serialized),
        diagnosis,
        error: serialized,
        message,
        relatedUserMessage,
        blockEntities,
        appInfo: await getDiagnosticAppInfo(),
        privacyNotice: t('agent.errorFallback.privacy_notice')
      })
      window.toast.success(t('agent.errorFallback.export_success', { path: savedPath }))
    } catch (exportError) {
      if (!String(exportError).toLowerCase().includes('canceled'))
        window.toast.error(t('agent.errorFallback.export_failed'))
    } finally {
      setExporting(false)
    }
  }

  // 如果有详细错误信息，添加到描述中
  const errorDescription =
    !isProd && error ? `${t('error.render.description')}: ${error.message}` : t('error.render.description')

  return (
    fallback || (
      <Alert
        message={t('error.render.title')}
        description={errorDescription}
        type="error"
        showIcon
        action={
          message ? (
            <Button size="small" loading={exporting} onClick={exportPackage}>
              {t('agent.errorFallback.export_package')}
            </Button>
          ) : undefined
        }
      />
    )
  )
}

class MessageErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    if (!getDiagnosticEvidence(this.props.messageId ?? '')) return
    recordDiagnostic(this.props.messageId, 'ui', 'failed', { error, componentStack: info.componentStack })
  }

  render() {
    if (this.state.hasError) {
      return <ErrorFallback fallback={this.props.fallback} error={this.state.error} messageId={this.props.messageId} />
    }
    return this.props.children
  }
}

export default MessageErrorBoundary
