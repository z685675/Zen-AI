import CodeViewer from '@renderer/components/CodeViewer'
import GeneralPopup from '@renderer/components/Popups/GeneralPopup'
import { useCodeStyle } from '@renderer/context/CodeStyleProvider'
import i18n from '@renderer/i18n'
import type { DiagnosisContext, DiagnosisResult } from '@renderer/services/ErrorDiagnosisService'
import type { Model } from '@renderer/types'
import type { SerializedAiSdkError, SerializedAiSdkErrorUnion, SerializedError } from '@renderer/types/error'
import {
  isSerializedAiSdkAPICallError,
  isSerializedAiSdkDownloadError,
  isSerializedAiSdkError,
  isSerializedAiSdkErrorUnion,
  isSerializedAiSdkInvalidArgumentError,
  isSerializedAiSdkInvalidDataContentError,
  isSerializedAiSdkInvalidMessageRoleError,
  isSerializedAiSdkInvalidPromptError,
  isSerializedAiSdkInvalidToolInputError,
  isSerializedAiSdkJSONParseError,
  isSerializedAiSdkMessageConversionError,
  isSerializedAiSdkNoObjectGeneratedError,
  isSerializedAiSdkNoSpeechGeneratedError,
  isSerializedAiSdkNoSuchModelError,
  isSerializedAiSdkNoSuchProviderError,
  isSerializedAiSdkNoSuchToolError,
  isSerializedAiSdkRetryError,
  isSerializedAiSdkToolCallRepairError,
  isSerializedAiSdkTooManyEmbeddingValuesForCallError,
  isSerializedAiSdkTypeValidationError,
  isSerializedAiSdkUnsupportedFunctionalityError,
  isSerializedError
} from '@renderer/types/error'
import { diagnoseClientError, formatClientErrorDiagnosis } from '@renderer/utils/clientErrorDiagnosis'
import { formatErrorForClipboard, safeToString } from '@renderer/utils/error'
import { parseDataUrl } from '@shared/utils'
import { Button } from 'antd'
import { CheckCircle, Copy, Loader2, Stethoscope } from 'lucide-react'
import React, { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import Scrollbar from '../Scrollbar'
import AIDiagnosisSectionWithStatus from './AIDiagnosisSection'

interface ErrorDetailContentProps {
  error?: SerializedError
  diagnosisContext?: DiagnosisContext
  blockId?: string
  messageId?: string
  model?: Model
  createdAt?: string
  cachedDiagnosis?: DiagnosisResult
}

const truncateLargeData = (
  data: string,
  t: (key: string) => string
): { content: string; truncated: boolean; isLikelyBase64: boolean } => {
  const parsed = parseDataUrl(data)
  const isLikelyBase64 = parsed?.isBase64 ?? false

  if (!data || data.length <= 100_000) {
    return { content: data, truncated: false, isLikelyBase64 }
  }

  if (isLikelyBase64) {
    return {
      content: `[${t('error.base64DataTruncated')}]`,
      truncated: true,
      isLikelyBase64: true
    }
  }

  return {
    content: data.slice(0, 100_000) + `\n\n... [${t('error.truncated')}]`,
    truncated: true,
    isLikelyBase64: false
  }
}

// --- Styled Components ---

const ErrorDetailContainer = styled(Scrollbar)`
  max-height: 60vh;
  padding-right: 5px;
`

const ErrorDetailList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 16px;
`

const ErrorDetailItem = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`

const ErrorDetailLabel = styled.div`
  font-weight: 600;
  color: var(--color-text);
  font-size: 14px;
`

const ErrorDetailValue = styled.div`
  font-family: var(--code-font-family);
  font-size: 12px;
  padding: 8px;
  background: var(--color-code-background);
  border-radius: 4px;
  border: 1px solid var(--color-border);
  word-break: break-word;
  color: var(--color-text);
`

const StackTrace = styled.div`
  background: var(--color-background-soft);
  border: 1px solid var(--color-error);
  border-radius: 6px;
  padding: 12px;

  pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--code-font-family);
    font-size: 12px;
    line-height: 1.4;
    color: var(--color-error);
  }
`

const TruncatedBadge = styled.span`
  margin-left: 8px;
  padding: 2px 6px;
  font-size: 10px;
  font-weight: normal;
  color: var(--color-warning);
  background: var(--color-warning-bg, rgba(250, 173, 20, 0.1));
  border-radius: 4px;
`

const DiagnosisPanel = styled.div`
  border: 1px solid color-mix(in srgb, var(--color-error) 18%, transparent);
  background: color-mix(in srgb, var(--color-error) 4%, transparent);
  border-radius: 8px;
  padding: 14px 16px;
  margin-bottom: 16px;
`

const DiagnosisTitle = styled.div`
  font-weight: 700;
  color: var(--color-error);
  font-size: 14px;
  margin-bottom: 6px;
`

const DiagnosisSummary = styled.div`
  color: var(--color-text-2);
  font-size: 13px;
  line-height: 1.6;
  margin-bottom: 12px;
`

const DiagnosisGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 12px;
`

const DiagnosisField = styled.div`
  min-width: 0;
  border-radius: 6px;
  background: color-mix(in srgb, var(--color-background-soft) 80%, transparent);
  border: 1px solid var(--color-border);
  padding: 8px 10px;
`

const DiagnosisFieldLabel = styled.div`
  color: var(--color-text-3);
  font-size: 11px;
  margin-bottom: 4px;
`

const DiagnosisFieldValue = styled.div`
  color: var(--color-text);
  font-size: 12px;
  line-height: 1.45;
  word-break: break-word;
`

// --- Sub-Components ---

const BuiltinError = memo(({ error }: { error: SerializedError }) => {
  const { t } = useTranslation()
  return (
    <>
      {error.name && (
        <ErrorDetailItem>
          <ErrorDetailLabel>{t('error.name')}:</ErrorDetailLabel>
          <ErrorDetailValue className="selectable">{error.name}</ErrorDetailValue>
        </ErrorDetailItem>
      )}
      {error.message && (
        <ErrorDetailItem>
          <ErrorDetailLabel>{t('error.message')}:</ErrorDetailLabel>
          <ErrorDetailValue className="selectable">{error.message}</ErrorDetailValue>
        </ErrorDetailItem>
      )}
      {error.stack && (
        <ErrorDetailItem>
          <ErrorDetailLabel>{t('error.stack')}:</ErrorDetailLabel>
          <StackTrace>
            <pre>{error.stack}</pre>
          </StackTrace>
        </ErrorDetailItem>
      )}
    </>
  )
})

const ClientDiagnosisSection = memo(
  ({
    error,
    blockId,
    messageId,
    model,
    createdAt
  }: {
    error?: SerializedError
    blockId?: string
    messageId?: string
    model?: Model
    createdAt?: string
  }) => {
    const diagnosis = diagnoseClientError(error, { blockId, messageId, model, createdAt })
    const fields = [
      ['发生阶段', diagnosis.stage],
      ['错误类型', diagnosis.errorType],
      ['HTTP 状态', diagnosis.httpStatus],
      ['服务连通性', diagnosis.serviceConnectivity],
      ['服务地址检测', diagnosis.serviceStatusCheck],
      ['模型接口检测', diagnosis.modelApiCheck],
      ['服务是否收到请求', diagnosis.serviceReceived],
      ['是否开始生成', diagnosis.startedGenerating],
      ['模型', diagnosis.model],
      ['服务地址', diagnosis.serviceAddress],
      ['发生时间', diagnosis.occurredAt],
      ['诊断编号', diagnosis.diagnosticId]
    ]

    return (
      <DiagnosisPanel>
        <DiagnosisTitle>{diagnosis.title}</DiagnosisTitle>
        <DiagnosisSummary>{diagnosis.summary}</DiagnosisSummary>
        <DiagnosisGrid>
          {fields.map(([label, value]) => (
            <DiagnosisField key={label}>
              <DiagnosisFieldLabel>{label}</DiagnosisFieldLabel>
              <DiagnosisFieldValue className="selectable">{value}</DiagnosisFieldValue>
            </DiagnosisField>
          ))}
        </DiagnosisGrid>
        <DiagnosisSummary style={{ marginTop: 12, marginBottom: 0 }}>建议操作：{diagnosis.suggestion}</DiagnosisSummary>
      </DiagnosisPanel>
    )
  }
)

const AiSdkErrorBase = memo(({ error }: { error: SerializedAiSdkError }) => {
  const { t } = useTranslation()
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  const { highlightCode } = useCodeStyle()
  const [highlightedString, setHighlightedString] = useState('')
  const [isTruncated, setIsTruncated] = useState(false)
  const cause = error.cause

  useEffect(() => {
    const highlight = async () => {
      try {
        const { content: truncatedCause, truncated, isLikelyBase64 } = truncateLargeData(cause || '', tRef.current)
        setIsTruncated(truncated)

        if (isLikelyBase64) {
          setHighlightedString(truncatedCause)
          return
        }

        try {
          const parsed = JSON.parse(truncatedCause || '{}')
          const formatted = JSON.stringify(parsed, null, 2)
          const result = await highlightCode(formatted, 'json')
          setHighlightedString(result)
        } catch {
          setHighlightedString(truncatedCause || '')
        }
      } catch {
        setHighlightedString(cause || '')
      }
    }
    const timer = setTimeout(highlight, 0)

    return () => clearTimeout(timer)
  }, [highlightCode, cause])

  return (
    <>
      <BuiltinError error={error} />
      {cause && (
        <ErrorDetailItem>
          <ErrorDetailLabel>
            {t('error.cause')}:{isTruncated && <TruncatedBadge>{t('error.truncatedBadge')}</TruncatedBadge>}
          </ErrorDetailLabel>
          <ErrorDetailValue>
            <div
              className="markdown [&_pre]:bg-transparent! [&_pre_span]:whitespace-pre-wrap"
              dangerouslySetInnerHTML={{ __html: highlightedString }}
            />
          </ErrorDetailValue>
        </ErrorDetailItem>
      )}
    </>
  )
})

const TruncatedCodeViewer = memo(
  ({ value, label, language = 'json' }: { value: string; label: string; language?: string }) => {
    const { t } = useTranslation()
    const { content, truncated, isLikelyBase64 } = truncateLargeData(value, t)

    return (
      <ErrorDetailItem>
        <ErrorDetailLabel>
          {label}:{truncated && <TruncatedBadge>{t('error.truncatedBadge')}</TruncatedBadge>}
        </ErrorDetailLabel>
        {isLikelyBase64 ? (
          <ErrorDetailValue>{content}</ErrorDetailValue>
        ) : (
          <CodeViewer value={content} className="source-view selectable" language={language} expanded />
        )}
      </ErrorDetailItem>
    )
  }
)

const AiSdkError = memo(({ error }: { error: SerializedAiSdkErrorUnion }) => {
  const { t } = useTranslation()

  return (
    <ErrorDetailList>
      {(isSerializedAiSdkAPICallError(error) || isSerializedAiSdkDownloadError(error)) && error.url && (
        <ErrorDetailItem>
          <ErrorDetailLabel>{t('error.requestUrl')}:</ErrorDetailLabel>
          <ErrorDetailValue className="selectable">{error.url}</ErrorDetailValue>
        </ErrorDetailItem>
      )}

      {isSerializedAiSdkAPICallError(error) && error.responseBody && (
        <TruncatedCodeViewer value={error.responseBody} label={t('error.responseBody')} />
      )}

      {(isSerializedAiSdkAPICallError(error) || isSerializedAiSdkDownloadError(error)) && error.statusCode && (
        <ErrorDetailItem>
          <ErrorDetailLabel>{t('error.statusCode')}:</ErrorDetailLabel>
          <ErrorDetailValue className="selectable">{error.statusCode}</ErrorDetailValue>
        </ErrorDetailItem>
      )}

      {isSerializedAiSdkAPICallError(error) && (
        <>
          {error.responseHeaders && (
            <ErrorDetailItem>
              <ErrorDetailLabel>{t('error.responseHeaders')}:</ErrorDetailLabel>
              <CodeViewer
                value={JSON.stringify(error.responseHeaders, null, 2)}
                className="source-view"
                language="json"
                expanded
              />
            </ErrorDetailItem>
          )}

          {error.requestBodyValues && (
            <TruncatedCodeViewer value={safeToString(error.requestBodyValues)} label={t('error.requestBodyValues')} />
          )}

          {error.data && <TruncatedCodeViewer value={safeToString(error.data)} label={t('error.data')} />}
        </>
      )}

      {isSerializedAiSdkDownloadError(error) && error.statusText && (
        <ErrorDetailItem>
          <ErrorDetailLabel>{t('error.statusText')}:</ErrorDetailLabel>
          <ErrorDetailValue>{error.statusText}</ErrorDetailValue>
        </ErrorDetailItem>
      )}

      {isSerializedAiSdkInvalidArgumentError(error) && error.parameter && (
        <ErrorDetailItem>
          <ErrorDetailLabel>{t('error.parameter')}:</ErrorDetailLabel>
          <ErrorDetailValue>{error.parameter}</ErrorDetailValue>
        </ErrorDetailItem>
      )}

      {(isSerializedAiSdkInvalidArgumentError(error) || isSerializedAiSdkTypeValidationError(error)) && error.value && (
        <ErrorDetailItem>
          <ErrorDetailLabel>{t('error.value')}:</ErrorDetailLabel>
          <ErrorDetailValue>{safeToString(error.value)}</ErrorDetailValue>
        </ErrorDetailItem>
      )}

      {isSerializedAiSdkInvalidDataContentError(error) && (
        <ErrorDetailItem>
          <ErrorDetailLabel>{t('error.content')}:</ErrorDetailLabel>
          <ErrorDetailValue>{safeToString(error.content)}</ErrorDetailValue>
        </ErrorDetailItem>
      )}

      {isSerializedAiSdkInvalidMessageRoleError(error) && (
        <ErrorDetailItem>
          <ErrorDetailLabel>{t('error.role')}:</ErrorDetailLabel>
          <ErrorDetailValue>{error.role}</ErrorDetailValue>
        </ErrorDetailItem>
      )}

      {isSerializedAiSdkInvalidPromptError(error) && (
        <ErrorDetailItem>
          <ErrorDetailLabel>{t('error.prompt')}:</ErrorDetailLabel>
          <ErrorDetailValue>{safeToString(error.prompt)}</ErrorDetailValue>
        </ErrorDetailItem>
      )}

      {isSerializedAiSdkInvalidToolInputError(error) && (
        <>
          {error.toolName && (
            <ErrorDetailItem>
              <ErrorDetailLabel>{t('error.toolName')}:</ErrorDetailLabel>
              <ErrorDetailValue>{error.toolName}</ErrorDetailValue>
            </ErrorDetailItem>
          )}
          {error.toolInput && (
            <ErrorDetailItem>
              <ErrorDetailLabel>{t('error.toolInput')}:</ErrorDetailLabel>
              <ErrorDetailValue>{error.toolInput}</ErrorDetailValue>
            </ErrorDetailItem>
          )}
        </>
      )}

      {(isSerializedAiSdkJSONParseError(error) || isSerializedAiSdkNoObjectGeneratedError(error)) && error.text && (
        <ErrorDetailItem>
          <ErrorDetailLabel>{t('error.text')}:</ErrorDetailLabel>
          <ErrorDetailValue>{error.text}</ErrorDetailValue>
        </ErrorDetailItem>
      )}

      {isSerializedAiSdkMessageConversionError(error) && (
        <ErrorDetailItem>
          <ErrorDetailLabel>{t('error.originalMessage')}:</ErrorDetailLabel>
          <ErrorDetailValue>{safeToString(error.originalMessage)}</ErrorDetailValue>
        </ErrorDetailItem>
      )}

      {isSerializedAiSdkNoSpeechGeneratedError(error) && error.responses && (
        <ErrorDetailItem>
          <ErrorDetailLabel>{t('error.responses')}:</ErrorDetailLabel>
          <ErrorDetailValue>{error.responses.join(', ')}</ErrorDetailValue>
        </ErrorDetailItem>
      )}

      {isSerializedAiSdkNoObjectGeneratedError(error) && (
        <>
          {error.response && (
            <ErrorDetailItem>
              <ErrorDetailLabel>{t('error.response')}:</ErrorDetailLabel>
              <ErrorDetailValue>{safeToString(error.response)}</ErrorDetailValue>
            </ErrorDetailItem>
          )}
          {error.usage && (
            <ErrorDetailItem>
              <ErrorDetailLabel>{t('error.usage')}:</ErrorDetailLabel>
              <ErrorDetailValue>{safeToString(error.usage)}</ErrorDetailValue>
            </ErrorDetailItem>
          )}
          {error.finishReason && (
            <ErrorDetailItem>
              <ErrorDetailLabel>{t('error.finishReason')}:</ErrorDetailLabel>
              <ErrorDetailValue>{error.finishReason}</ErrorDetailValue>
            </ErrorDetailItem>
          )}
        </>
      )}

      {(isSerializedAiSdkNoSuchModelError(error) ||
        isSerializedAiSdkNoSuchProviderError(error) ||
        isSerializedAiSdkTooManyEmbeddingValuesForCallError(error)) &&
        error.modelId && (
          <ErrorDetailItem>
            <ErrorDetailLabel>{t('error.modelId')}:</ErrorDetailLabel>
            <ErrorDetailValue>{error.modelId}</ErrorDetailValue>
          </ErrorDetailItem>
        )}

      {(isSerializedAiSdkNoSuchModelError(error) || isSerializedAiSdkNoSuchProviderError(error)) && error.modelType && (
        <ErrorDetailItem>
          <ErrorDetailLabel>{t('error.modelType')}:</ErrorDetailLabel>
          <ErrorDetailValue>{error.modelType}</ErrorDetailValue>
        </ErrorDetailItem>
      )}

      {isSerializedAiSdkNoSuchProviderError(error) && (
        <>
          <ErrorDetailItem>
            <ErrorDetailLabel>{t('error.providerId')}:</ErrorDetailLabel>
            <ErrorDetailValue>{error.providerId}</ErrorDetailValue>
          </ErrorDetailItem>

          <ErrorDetailItem>
            <ErrorDetailLabel>{t('error.availableProviders')}:</ErrorDetailLabel>
            <ErrorDetailValue>{error.availableProviders.join(', ')}</ErrorDetailValue>
          </ErrorDetailItem>
        </>
      )}

      {isSerializedAiSdkNoSuchToolError(error) && (
        <>
          <ErrorDetailItem>
            <ErrorDetailLabel>{t('error.toolName')}:</ErrorDetailLabel>
            <ErrorDetailValue>{error.toolName}</ErrorDetailValue>
          </ErrorDetailItem>
          {error.availableTools && (
            <ErrorDetailItem>
              <ErrorDetailLabel>{t('error.availableTools')}:</ErrorDetailLabel>
              <ErrorDetailValue>{error.availableTools?.join(', ') || t('common.none')}</ErrorDetailValue>
            </ErrorDetailItem>
          )}
        </>
      )}

      {isSerializedAiSdkRetryError(error) && (
        <>
          {error.reason && (
            <ErrorDetailItem>
              <ErrorDetailLabel>{t('error.reason')}:</ErrorDetailLabel>
              <ErrorDetailValue>{error.reason}</ErrorDetailValue>
            </ErrorDetailItem>
          )}
          {error.lastError && (
            <ErrorDetailItem>
              <ErrorDetailLabel>{t('error.lastError')}:</ErrorDetailLabel>
              <ErrorDetailValue>{safeToString(error.lastError)}</ErrorDetailValue>
            </ErrorDetailItem>
          )}
          {error.errors && error.errors.length > 0 && (
            <ErrorDetailItem>
              <ErrorDetailLabel>{t('error.errors')}:</ErrorDetailLabel>
              <ErrorDetailValue>{error.errors.map((e) => safeToString(e)).join('\n\n')}</ErrorDetailValue>
            </ErrorDetailItem>
          )}
        </>
      )}

      {isSerializedAiSdkTooManyEmbeddingValuesForCallError(error) && (
        <>
          {error.provider && (
            <ErrorDetailItem>
              <ErrorDetailLabel>{t('error.provider')}:</ErrorDetailLabel>
              <ErrorDetailValue>{error.provider}</ErrorDetailValue>
            </ErrorDetailItem>
          )}
          {error.maxEmbeddingsPerCall && (
            <ErrorDetailItem>
              <ErrorDetailLabel>{t('error.maxEmbeddingsPerCall')}:</ErrorDetailLabel>
              <ErrorDetailValue>{error.maxEmbeddingsPerCall}</ErrorDetailValue>
            </ErrorDetailItem>
          )}
          {error.values && (
            <ErrorDetailItem>
              <ErrorDetailLabel>{t('error.values')}:</ErrorDetailLabel>
              <ErrorDetailValue>{safeToString(error.values)}</ErrorDetailValue>
            </ErrorDetailItem>
          )}
        </>
      )}

      {isSerializedAiSdkToolCallRepairError(error) && (
        <ErrorDetailItem>
          <ErrorDetailLabel>{t('error.originalError')}:</ErrorDetailLabel>
          <ErrorDetailValue>{safeToString(error.originalError)}</ErrorDetailValue>
        </ErrorDetailItem>
      )}

      {isSerializedAiSdkUnsupportedFunctionalityError(error) && (
        <ErrorDetailItem>
          <ErrorDetailLabel>{t('error.functionality')}:</ErrorDetailLabel>
          <ErrorDetailValue>{error.functionality}</ErrorDetailValue>
        </ErrorDetailItem>
      )}

      <AiSdkErrorBase error={error} />
    </ErrorDetailList>
  )
})

// --- Main Content Component ---

const ErrorDetailContent: React.FC<ErrorDetailContentProps> = ({
  error,
  diagnosisContext,
  blockId,
  messageId,
  model,
  createdAt,
  cachedDiagnosis
}) => {
  const { t } = useTranslation()
  const [diagStatus, setDiagStatus] = useState<'idle' | 'loading' | 'done' | 'error'>(cachedDiagnosis ? 'done' : 'idle')
  const diagSectionRef = useRef<{ runDiagnosis: () => void }>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const isInitialRenderRef = useRef(true)

  // Scroll to bottom when diagnosis status changes, but skip initial render
  useEffect(() => {
    if (isInitialRenderRef.current) {
      isInitialRenderRef.current = false
      return
    }

    if (diagStatus !== 'idle') {
      requestAnimationFrame(() => {
        containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight, behavior: 'smooth' })
      })
    }
  }, [diagStatus])

  const copyErrorDetails = useCallback(() => {
    if (!error) {
      return
    }

    let errorText: string
    if (isSerializedAiSdkError(error)) {
      errorText = formatErrorForClipboard(error)
    } else if (isSerializedError(error)) {
      errorText = formatErrorForClipboard(error)
    } else {
      errorText = safeToString(error)
    }

    const diagnosis = diagnoseClientError(error, { blockId, messageId, model, createdAt })
    const copyText = `${formatClientErrorDiagnosis(diagnosis)}\n\n${errorText}`

    void navigator.clipboard.writeText(copyText)
    window.toast.success(t('message.copied'))
  }, [blockId, createdAt, error, messageId, model, t])

  const renderErrorDetails = (error?: SerializedError) => {
    if (!error) {
      return <div>{t('error.unknown')}</div>
    }

    if (isSerializedAiSdkErrorUnion(error)) {
      return <AiSdkError error={error} />
    }

    return (
      <ErrorDetailList>
        <BuiltinError error={error} />
      </ErrorDetailList>
    )
  }

  const handleDiagnose = () => {
    if (diagStatus === 'loading') return
    setDiagStatus('loading')
    diagSectionRef.current?.runDiagnosis()
  }

  const getDiagButtonText = () => {
    switch (diagStatus) {
      case 'loading':
        return t('error.diagnosis.ai_loading') + '...'
      case 'done':
        return t('error.diagnosis.ai_done')
      default:
        return t('error.diagnosis.ai_button')
    }
  }

  return (
    <>
      <ErrorDetailContainer ref={containerRef}>
        <ClientDiagnosisSection
          error={error}
          blockId={blockId}
          messageId={messageId}
          model={model}
          createdAt={createdAt}
        />
        {renderErrorDetails(error)}
        {diagStatus !== 'idle' && (
          <AIDiagnosisSectionWithStatus
            key={blockId ?? error?.message}
            ref={diagSectionRef}
            error={error}
            status={diagStatus}
            onStatusChange={setDiagStatus}
            diagnosisContext={diagnosisContext}
            blockId={blockId}
            cachedDiagnosis={cachedDiagnosis}
          />
        )}
      </ErrorDetailContainer>
      <div className="my-2 mt-4 flex justify-end gap-2">
        <Button color="default" icon={<Copy size={14} />} onClick={copyErrorDetails}>
          {t('common.copy')}
        </Button>
        <Button
          type="primary"
          disabled={diagStatus === 'loading'}
          icon={
            diagStatus === 'loading' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : diagStatus === 'done' ? (
              <CheckCircle size={14} />
            ) : (
              <Stethoscope size={14} />
            )
          }
          onClick={handleDiagnose}>
          {getDiagButtonText()}
        </Button>
      </div>
    </>
  )
}

export function showErrorDetailPopup(params: ErrorDetailContentProps) {
  void GeneralPopup.show({
    title: i18n.t('error.detail'),
    content: <ErrorDetailContent {...params} />,
    footer: null,
    width: '60vw',
    style: { maxWidth: '1200px', minWidth: '600px' }
  })
}

export { ErrorDetailContent }
export type { ErrorDetailContentProps }
