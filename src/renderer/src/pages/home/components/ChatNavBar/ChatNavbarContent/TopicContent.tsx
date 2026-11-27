import type { Assistant, Topic } from '@renderer/types'

import Tools from '../Tools'

type TopicContentProps = {
  assistant: Assistant
  assistants: Assistant[]
  activeTopic: Topic
  setActiveAssistant: (assistant: Assistant) => void
  setActiveTopic: (topic: Topic) => void
  persistAsDefault: boolean
}

const TopicContent = ({ assistant }: TopicContentProps) => {
  return <Tools assistant={assistant} />
}

export default TopicContent
