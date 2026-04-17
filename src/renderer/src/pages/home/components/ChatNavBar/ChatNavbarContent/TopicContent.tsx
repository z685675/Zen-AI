import type { Assistant } from '@renderer/types'

import AssistantSwitchButton from '../../AssistantSwitchButton'
import SelectModelButton from '../../SelectModelButton'
import Tools from '../Tools'

type TopicContentProps = {
  assistant: Assistant
  assistants: Assistant[]
  setActiveAssistant: (assistant: Assistant) => void
}

const TopicContent = ({ assistant, assistants, setActiveAssistant }: TopicContentProps) => {
  return (
    <>
      <div className="ml-2 flex min-w-0 flex-initial items-center gap-2.5">
        <AssistantSwitchButton
          assistant={assistant}
          assistants={assistants}
          onSelectAssistant={setActiveAssistant}
        />
        <SelectModelButton assistant={assistant} />
      </div>
      <Tools assistant={assistant} />
    </>
  )
}

export default TopicContent
