import type { Assistant, Topic } from '@renderer/types'
import type { FC } from 'react'

import TopicContent from './TopicContent'

interface Props {
  assistant: Assistant
  assistants: Assistant[]
  activeTopic: Topic
  setActiveAssistant: (assistant: Assistant) => void
  setActiveTopic: (topic: Topic) => void
  persistAsDefault: boolean
}

const ChatNavbarContent: FC<Props> = ({
  assistant,
  assistants,
  activeTopic,
  setActiveAssistant,
  setActiveTopic,
  persistAsDefault
}) => {
  return (
    <div className="flex min-w-0 shrink items-center justify-end">
      <TopicContent
        assistant={assistant}
        assistants={assistants}
        activeTopic={activeTopic}
        setActiveAssistant={setActiveAssistant}
        setActiveTopic={setActiveTopic}
        persistAsDefault={persistAsDefault}
      />
    </div>
  )
}

export default ChatNavbarContent
