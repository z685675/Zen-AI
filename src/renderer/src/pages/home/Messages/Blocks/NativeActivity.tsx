import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import type { MessageBlock, ThinkingMessageBlock, ToolMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import { ChevronRight, LoaderCircle, Sparkles } from 'lucide-react'
import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { useToolApproval } from '../Tools/hooks/useToolApproval'
import { getEffectiveStatus, getToolHasError } from '../Tools/MessageAgentTools/GenericTools'
import ToolHeader from '../Tools/ToolHeader'
import BlockErrorFallback from './BlockErrorFallback'
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
  if (!approval.isWaiting && !approval.isSubmitting) return null
  return (
    <div data-native-approval={block.id}>
      <ToolBlock block={block} />
    </div>
  )
}

function ToolActivity({ block }: { block: ToolMessageBlock }) {
  const approval = useToolApproval(block)
  const response = block.metadata?.rawMcpToolResponse
  const status = getEffectiveStatus(response?.status, approval.isWaiting, getToolHasError(response))
  if (approval.isWaiting || approval.isSubmitting) return null
  return (
    <details data-native-tool={block.id}>
      <summary>
        <ToolHeader block={block} variant="collapse-label" status={status} />
      </summary>
      <DetailBody>
        <ToolBlock block={block} />
      </DetailBody>
    </details>
  )
}

/** Presentation only. Does not alter native events, tools, permissions or artifacts. */
function NativeActivity({ blocks, processing }: { blocks: NativeActivityBlock[]; processing: boolean }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const tools = blocks.filter((block): block is ToolMessageBlock => block.type === MessageBlockType.TOOL)
  const failures = tools.filter((block) => getToolHasError(block.metadata?.rawMcpToolResponse)).length
  const currentTool = processing
    ? tools.findLast((block) =>
        ['pending', 'invoking', 'streaming'].includes(block.metadata?.rawMcpToolResponse?.status ?? '')
      )
    : undefined
  return (
    <Container>
      <Toggle type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {processing ? <LoaderCircle size={14} className="activity-spinner" /> : <Sparkles size={14} />}
        <span>
          {t(
            tools.length === 0
              ? 'nativeActivity.thinking'
              : processing
                ? 'nativeActivity.running'
                : 'nativeActivity.finished',
            { count: tools.length }
          )}
        </span>
        <ChevronRight size={13} style={{ transform: expanded ? 'rotate(90deg)' : undefined }} />
      </Toggle>
      {currentTool && (
        <Current>
          <ToolHeader block={currentTool} variant="collapse-label" />
        </Current>
      )}
      {failures > 0 && <Hint>{t('nativeActivity.failures', { count: failures })}</Hint>}
      {/* Always mounted, including before the user opens the execution log. */}
      {tools
        .filter((block) => !['done', 'error', 'cancelled'].includes(block.metadata?.rawMcpToolResponse?.status ?? ''))
        .map((block) => (
          <ErrorBoundary key={block.id} fallbackComponent={BlockErrorFallback}>
            <PendingApproval block={block} />
          </ErrorBoundary>
        ))}
      {expanded && (
        <Timeline>
          {blocks.map((block) => (
            <ErrorBoundary key={block.id} fallbackComponent={BlockErrorFallback}>
              {block.type === MessageBlockType.TOOL ? (
                <ToolActivity block={block} />
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
    </Container>
  )
}
export default memo(NativeActivity)

const Container = styled.div`
  margin: 6px 0 12px;
  color: var(--color-text-2);
  font-size: 12px;
  @keyframes native-activity-spin { to { transform: rotate(360deg); } }
  .activity-spinner { animation: native-activity-spin 1.5s linear infinite; }
  @media (prefers-reduced-motion: reduce) { .activity-spinner { animation: none; } }
`
const Toggle = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  padding: 5px 0;
  cursor: pointer;
  &:hover { color: var(--color-text-1); }
`
const Current = styled.div`
  margin: 2px 0 2px 20px;
  max-width: 100%;
  overflow-wrap: anywhere;
`
const Hint = styled.div`
  margin: 2px 0 4px 20px;
  color: var(--color-text-3);
`
const Timeline = styled.div`
  margin: 6px 0 0 7px;
  padding-left: 14px;
  border-left: 1px solid var(--color-border);
  > details { margin: 5px 0; }
  summary {
    cursor: pointer;
    padding: 4px 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  summary::before { content: '›'; color: var(--color-text-3); }
  details[open] > summary::before { transform: rotate(90deg); }
`
const DetailBody = styled.div`
  margin: 5px 0 8px;
  max-height: 400px;
  overflow: auto;
`
const ThinkingText = styled.pre`
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 300px;
  overflow: auto;
  font: inherit;
  line-height: 1.65;
  color: var(--color-text-2);
`
