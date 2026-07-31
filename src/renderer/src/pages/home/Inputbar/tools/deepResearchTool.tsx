import { Tooltip } from 'antd'
import { Telescope } from 'lucide-react'
import styled from 'styled-components'

import { defineTool, registerTool, TopicType } from '../types'

const deepResearchTool = defineTool({
  key: 'deep_research',
  label: (t) => t('agent.input.deep_research', 'Deep Research'),
  visibleInScopes: [TopicType.Session],
  condition: ({ session }) => Boolean(session?.onDeepResearchChange),

  render: ({ t, session }) => {
    const enabled = session?.deepResearchEnabled === true
    const label = t('agent.input.deep_research', 'Deep Research')
    const tooltip = t(
      'agent.input.deep_research_tooltip',
      'Creates one research task for your next message with high reasoning effort while keeping the current model: plan first, then multi-step source verification and a cited report.'
    )

    return (
      <Tooltip title={tooltip} placement="top" mouseLeaveDelay={0} arrow>
        <DeepResearchButton
          type="button"
          $active={enabled}
          aria-label={tooltip}
          aria-pressed={enabled}
          onClick={() => session?.onDeepResearchChange?.(!enabled)}>
          <Telescope size={17} />
          <span>{label}</span>
        </DeepResearchButton>
      </Tooltip>
    )
  }
})

const DeepResearchButton = styled.button<{ $active: boolean }>`
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  gap: 6px;
  height: 34px;
  padding: 0 11px;
  border: 1px solid ${(props) => (props.$active ? 'var(--color-primary)' : 'var(--color-border)')};
  border-radius: 999px;
  background: ${(props) => (props.$active ? 'var(--color-primary-soft)' : 'var(--color-background)')};
  color: ${(props) => (props.$active ? 'var(--color-primary)' : 'var(--color-text)')};
  font-size: 12px;
  font-weight: 500;
  transition:
    border-color 0.18s ease,
    background-color 0.18s ease,
    box-shadow 0.18s ease,
    color 0.18s ease;

  svg {
    flex-shrink: 0;
  }

  span {
    white-space: nowrap;
  }

  &:hover {
    border-color: var(--color-primary);
    background: var(--color-primary-soft);
    box-shadow: 0 4px 10px rgba(15, 23, 42, 0.06);
  }
`

registerTool(deepResearchTool)

export default deepResearchTool
