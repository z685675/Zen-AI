import type { ToolMessageBlock } from '@renderer/types/newMessage'

import {
  AssistantCreateFileTool,
  isAssistantFileOutputToolName,
  parseAssistantFileResults
} from './MessageAgentTools/AssistantCreateFileTool'
import MessageMcpTool from './MessageMcpTool'
import MessageTool from './MessageTool'

interface Props {
  block: ToolMessageBlock
}

export default function MessageTools({ block }: Props) {
  const toolResponse = block.metadata?.rawMcpToolResponse
  if (!toolResponse) return null

  const tool = toolResponse.tool
  const isAssistantFileOutput = isAssistantFileOutputToolName(tool.name) || isAssistantFileOutputToolName(tool.id)
  if (isAssistantFileOutput && parseAssistantFileResults(toolResponse.response).length > 0) {
    return <AssistantCreateFileTool response={toolResponse.response} />
  }

  if (tool.type === 'mcp') {
    return <MessageMcpTool block={block} />
  }

  return <MessageTool block={block} />
}
