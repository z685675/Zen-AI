import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { createModelLatencyFormatter } from '@renderer/pages/model-status/modelLatency'
import type { MessageBlock, ThinkingMessageBlock, ToolMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import type { OpenCodeSubagentProgress } from '@shared/agents/opencodeSubagents'
import { ChevronRight, Sparkles } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { memo, useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { useToolApproval } from '../Tools/hooks/useToolApproval'
import { getEffectiveStatus, getToolHasError } from '../Tools/MessageAgentTools/GenericTools'
import ToolHeader from '../Tools/ToolHeader'
import BlockErrorFallback from './BlockErrorFallback'
import SubagentProgress from './SubagentProgress'
import ToolBlock from './ToolBlock'

export type NativeActivityBlock = ThinkingMessageBlock | ToolMessageBlock

/** An empty thinking-start placeholder is not actual model output. */
export function collectNativeActivity(blocks: readonly MessageBlock[]): NativeActivityBlock[] {
  return blocks.filter(
    (block): block is NativeActivityBlock =>
      (block.type === MessageBlockType.TOOL && Boolean(block.metadata?.rawMcpToolResponse)) ||
      (block.type === MessageBlockType.THINKING && block.content.trim().length > 0)
  )
}

/** Confirmation is outside the collapsed log and keeps the original input/risk controls. */
function PendingApproval({ block }: { block: ToolMessageBlock }) {
  const approval = useToolApproval(block)
  if (block.metadata?.rawMcpToolResponse?.tool.name === 'question') return null
  if (!approval.isWaiting && !approval.isSubmitting) return null
  return (
    <div data-native-approval={block.id}>
      <ToolBlock block={block} />
    </div>
  )
}

function ToolActivity({ block, formatDuration }: { block: ToolMessageBlock; formatDuration: (ms: number) => string }) {
  const approval = useToolApproval(block)
  const response = block.metadata?.rawMcpToolResponse
  const status = getEffectiveStatus(response?.status, approval.isWaiting, getToolHasError(response))
  const duration = Date.parse(block.updatedAt ?? '') - Date.parse(block.createdAt)
  if (approval.isWaiting || approval.isSubmitting) return null
  return (
    <details data-native-tool={block.id}>
      <summary>
        <ToolHeader
          block={block}
          variant="collapse-label"
          status={status}
          stats={duration > 0 && <Duration>{formatDuration(duration)}</Duration>}
        />
      </summary>
      <DetailBody>
        <ToolBlock block={block} />
      </DetailBody>
    </details>
  )
}

/** Presentation only. Does not alter native events, tools, permissions or artifacts. */
function NativeActivity({
  blocks,
  processing,
  subagents = [],
  elapsedMs
}: {
  blocks: NativeActivityBlock[]
  processing: boolean
  subagents?: OpenCodeSubagentProgress[]
  elapsedMs?: number
}) {
  const { t, i18n } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(Date.now)
  const timelineId = useId()
  const durationParts = useMemo(() => createModelLatencyFormatter(i18n?.language ?? 'en'), [i18n?.language])
  const formatDuration = (ms: number) =>
    durationParts(ms)
      .map(({ value }) => value)
      .join('')
  const tools = blocks.filter((block): block is ToolMessageBlock => block.type === MessageBlockType.TOOL)
  const failures = tools.filter((block) => getToolHasError(block.metadata?.rawMcpToolResponse)).length
  const started = Math.min(...blocks.map((block) => Date.parse(block.createdAt)).filter(Number.isFinite))
  const ended = Math.max(...blocks.map((block) => Date.parse(block.updatedAt ?? '')).filter(Number.isFinite))
  const elapsed = processing && Number.isFinite(started) ? Math.max(0, now - started) : (elapsedMs ?? ended - started)
  const tone = processing ? 'running' : failures ? 'error' : 'success'
  const summary = tools.length
    ? t(processing ? 'nativeActivity.running' : 'nativeActivity.finished', { count: tools.length })
    : !subagents.length
      ? t('nativeActivity.thinking')
      : ''
  const helpers = subagents.length ? `${t('nativeSubagents.title')} · ${subagents.length}` : ''
  const currentTool = processing
    ? tools.findLast((block) =>
        ['pending', 'invoking', 'streaming'].includes(block.metadata?.rawMcpToolResponse?.status ?? '')
      )
    : undefined
  useEffect(() => {
    if (!processing || !Number.isFinite(started)) return
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [processing, started])

  return (
    <Container>
      <Toggle type="button" aria-expanded={expanded} aria-controls={timelineId} onClick={() => setExpanded(!expanded)}>
        <StatusDot data-tone={tone} aria-hidden="true" />
        <Summary>
          {[summary, helpers, failures ? t('nativeActivity.failures', { count: failures }) : '']
            .filter(Boolean)
            .join(' · ')}
        </Summary>
        {Number.isFinite(elapsed) && elapsed >= 0 && <Duration>{formatDuration(elapsed)}</Duration>}
        <ChevronRight size={13} style={{ transform: expanded ? 'rotate(90deg)' : undefined }} />
      </Toggle>
      <AnimatePresence initial={false}>
        {expanded && (
          <Timeline
            id={timelineId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.16 }}>
            <SubagentProgress tasks={subagents} />
            {currentTool && (
              <div className="py-1">
                <ToolHeader block={currentTool} variant="collapse-label" />
              </div>
            )}
            {blocks.map((block) => (
              <ErrorBoundary key={block.id} fallbackComponent={BlockErrorFallback}>
                {block.type === MessageBlockType.TOOL ? (
                  <ToolActivity block={block} formatDuration={formatDuration} />
                ) : block.content ? (
                  <details>
                    <summary>
                      <Sparkles size={13} /> {t('nativeActivity.thinking')}
                    </summary>
                    <ThinkingText>{block.content}</ThinkingText>
                  </details>
                ) : null}
              </ErrorBoundary>
            ))}
          </Timeline>
        )}
      </AnimatePresence>
      {tools
        .filter((block) => !['done', 'error', 'cancelled'].includes(block.metadata?.rawMcpToolResponse?.status ?? ''))
        .map((block) => (
          <ErrorBoundary key={block.id} fallbackComponent={BlockErrorFallback}>
            <PendingApproval block={block} />
          </ErrorBoundary>
        ))}
    </Container>
  )
}
export default memo(NativeActivity)

const Container = styled.div`
  margin: 8px 0 12px;
  overflow: hidden;
  color: var(--zen-text-2);
  background: var(--zen-bg-elevated);
  border: 1px solid var(--zen-border);
  border-radius: var(--zen-radius-md);
  font-size: 12px;

  > [data-native-approval] {
    padding: 0 10px 8px;
  }
`

const Toggle = styled.button`
  display: flex;
  align-items: center;
  width: 100%;
  height: 30px;
  gap: 8px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  padding: 0 9px;
  cursor: pointer;

  &:hover {
    background: var(--zen-bg-hover);
    color: var(--zen-text-1);
  }

  &:focus-visible {
    outline: 1px solid var(--zen-border-strong);
    outline-offset: -1px;
  }

  svg {
    flex: none;
    transition: transform 160ms ease-out;
  }
`

const StatusDot = styled.span`
  flex: 0 0 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--zen-success);

  &[data-tone='running'] {
    background: var(--zen-warning);
  }

  &[data-tone='error'] {
    background: var(--zen-danger);
  }
`

const Summary = styled.span`
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: start;
`

const Duration = styled.span`
  flex: none;
  color: var(--zen-text-2);
  font-family: var(--code-font-family);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
`

const Timeline = styled(motion.div)`
  overflow: hidden;
  padding: 0 10px;
  border-top: 1px solid var(--zen-border);

  > details:not(:last-child) {
    border-bottom: 1px solid var(--zen-border);
  }

  summary {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 30px;
    cursor: pointer;
  }

  summary::before {
    content: '›';
    color: var(--zen-text-3);
  }

  details[open] > summary::before {
    transform: rotate(90deg);
  }
`

const DetailBody = styled.div`
  margin: 4px 0 8px 12px;
  max-height: 400px;
  overflow: auto;
`

const ThinkingText = styled.pre`
  max-height: 300px;
  overflow: auto;
  padding: 8px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--zen-code-bg);
  font: inherit;
  line-height: var(--zen-reading-line-height);
`
