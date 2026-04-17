import type { Assistant } from '@renderer/types'
import type { FC } from 'react'

import TopicContent from './TopicContent'

interface Props {
  assistant: Assistant
  assistants: Assistant[]
  setActiveAssistant: (assistant: Assistant) => void
}

const ChatNavbarContent: FC<Props> = ({ assistant, assistants, setActiveAssistant }) => {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-between">
      <TopicContent assistant={assistant} assistants={assistants} setActiveAssistant={setActiveAssistant} />
    </div>
  )
}

export default ChatNavbarContent
