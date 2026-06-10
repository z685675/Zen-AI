import { defineTool, registerTool, TopicType } from '@renderer/pages/home/Inputbar/types'

import MentionModelsQuickPanelManager from './components/MentionModelsQuickPanelManager'

/**
 * Mention Models Tool
 *
 * Allows users to mention multiple AI models in their messages.
 * Uses @ trigger to open model selection panel.
 */
const mentionModelsTool = defineTool({
  key: 'mention_models',
  label: (t) => t('assistants.presets.edit.model.select.title'),

  visibleInScopes: [TopicType.Chat, 'mini-window'],
  dependencies: {
    state: ['mentionedModels', 'files', 'couldMentionNotVisionModel'] as const,
    actions: ['setMentionedModels', 'onTextChange'] as const
  },

  render: null,
  quickPanelManager: MentionModelsQuickPanelManager
})

registerTool(mentionModelsTool)

export default mentionModelsTool
