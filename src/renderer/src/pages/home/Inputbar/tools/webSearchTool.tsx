import { isMandatoryWebSearchModel } from '@renderer/config/models'
import { defineTool, registerTool, TopicType } from '@renderer/pages/home/Inputbar/types'

import WebSearchButton from './components/WebSearchButton'

/**
 * Web Search Tool
 *
 * Toggles the built-in free-search chain for the current conversation.
 */
const webSearchTool = defineTool({
  key: 'web_search',
  label: (t) => t('chat.input.web_search.label'),

  visibleInScopes: [TopicType.Chat],
  condition: ({ model }) => !model || !isMandatoryWebSearchModel(model),

  render: function WebSearchToolRender(context) {
    const { topic, onTopicChange } = context

    if (!topic || !onTopicChange) {
      return null
    }

    return <WebSearchButton topic={topic} onTopicChange={onTopicChange} />
  }
})

registerTool(webSearchTool)

export default webSearchTool
