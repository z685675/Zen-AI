import type { ToolMessageBlock } from '@renderer/types/newMessage'

import { AssistantCreateFileTool, parseAssistantCreateFileResult } from './MessageAgentTools/AssistantCreateFileTool'
import MessageMcpTool from './MessageMcpTool'
import MessageTool from './MessageTool'

interface Props {
  block: ToolMessageBlock
}

export default function MessageTools({ block }: Props) {
  const toolResponse = block.metadata?.rawMcpToolResponse
  if (!toolResponse) return null

  const tool = toolResponse.tool
  if (tool.name === 'mcp__assistant__create_file' && parseAssistantCreateFileResult(toolResponse.response)) {
    return <AssistantCreateFileTool response={toolResponse.response} />
  }

  if (tool.type === 'mcp') {
    return <MessageMcpTool block={block} />
  }

  return <MessageTool block={block} />
}
