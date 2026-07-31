import type { Assistant, Topic } from '@renderer/types'

import AssistantSwitchButton from '../../AssistantSwitchButton'
import SelectModelButton from '../../SelectModelButton'
import Tools from '../Tools'

type TopicContentProps = {
  assistant: Assistant
  assistants: Assistant[]
  activeTopic: Topic
  setActiveAssistant: (assistant: Assistant) => void
  setActiveTopic: (topic: Topic) => void
}

const TopicContent = ({
  assistant,
  assistants,
  activeTopic,
  setActiveAssistant,
  setActiveTopic
}: TopicContentProps) => {
  return (
    <>
      <div className="ml-2 flex min-w-0 flex-initial items-center gap-2.5">
        <AssistantSwitchButton assistant={assistant} assistants={assistants} onSelectAssistant={setActiveAssistant} />
        <SelectModelButton assistant={assistant} topic={activeTopic} onTopicChange={setActiveTopic} />
      </div>
      <Tools assistant={assistant} />
    </>
  )
}

export default TopicContent
