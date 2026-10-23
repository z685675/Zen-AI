import QuickPhrasesButton from '@renderer/pages/home/Inputbar/tools/components/QuickPhrasesButton'
import { defineTool, registerTool, TopicType } from '@renderer/pages/home/Inputbar/types'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'

const quickPhrasesTool = defineTool({
  key: 'quick_phrases',
  label: (t) => t('settings.quickPhrase.title'),

  visibleInScopes: [TopicType.Chat, TopicType.Session, 'mini-window'],
  condition: ({ scope, session, assistant }) =>
    scope !== TopicType.Session || (session?.agentId ?? assistant.id) !== DEFAULT_OPENCODE_AGENT_ID,

  dependencies: {
    actions: ['onTextChange', 'resizeTextArea'] as const
  },

  render: (context) => {
    const { assistant, actions, quickPanel } = context

    return (
      <QuickPhrasesButton
        quickPanel={quickPanel}
        setInputValue={actions.onTextChange}
        resizeTextArea={actions.resizeTextArea}
        assistantId={assistant.id}
      />
    )
  }
})

registerTool(quickPhrasesTool)

export default quickPhrasesTool
