import type { Assistant, Topic } from '@renderer/types'
import type { FC } from 'react'

import TopicContent from './TopicContent'

interface Props {
  assistant: Assistant
  assistants: Assistant[]
  activeTopic: Topic
  setActiveAssistant: (assistant: Assistant) => void
}

const ChatNavbarContent: FC<Props> = ({ assistant, assistants, activeTopic, setActiveAssistant }) => {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-between">
      <TopicContent
        assistant={assistant}
        assistants={assistants}
        activeTopic={activeTopic}
        setActiveAssistant={setActiveAssistant}
      />
    </div>
  )
}

export default ChatNavbarContent
