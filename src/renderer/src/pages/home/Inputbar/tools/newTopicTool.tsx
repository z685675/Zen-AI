import { defineTool, registerTool, TopicType } from '@renderer/pages/home/Inputbar/types'

const newTopicTool = defineTool({
  key: 'new_topic',
  label: (t) => t('chat.input.new_topic', { Command: '' }),

  visibleInScopes: [TopicType.Chat],
  render: null
})

// Register the tool
registerTool(newTopicTool)

export default newTopicTool
