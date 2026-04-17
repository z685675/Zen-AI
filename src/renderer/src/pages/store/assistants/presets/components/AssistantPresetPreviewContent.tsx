import type { AssistantPreset } from '@renderer/types'
import { Flex } from 'antd'
import type { FC } from 'react'
import ReactMarkdown from 'react-markdown'
import styled from 'styled-components'

interface Props {
  preset: Pick<AssistantPreset, 'description' | 'prompt'>
}

const AssistantPresetPreviewContent: FC<Props> = ({ preset }) => {
  return (
    <Container gap={16} vertical>
      {preset.description && <AgentDescription>{preset.description}</AgentDescription>}

      {preset.prompt && (
        <AgentPrompt className="markdown">
          <ReactMarkdown>{preset.prompt}</ReactMarkdown>
        </AgentPrompt>
      )}
    </Container>
  )
}

const Container = styled(Flex)`
  width: calc(100% + 12px);
`

const AgentDescription = styled.div`
  color: var(--color-text-2);
  font-size: 12px;
`

const AgentPrompt = styled.div`
  max-height: 60vh;
  overflow-y: scroll;
  background-color: var(--color-background-soft);
  padding: 8px;
  border-radius: 10px;
`

export default AssistantPresetPreviewContent
