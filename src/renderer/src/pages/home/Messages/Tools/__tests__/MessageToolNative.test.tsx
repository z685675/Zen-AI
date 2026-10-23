import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import MessageTool from '../MessageTool'

vi.mock('../MessageAgentTools', () => ({
  MessageAgentTools: ({ toolResponse }: any) => (
    <div data-testid="agent-tool">
      {toolResponse.tool.name}:{toolResponse.arguments.filePath}
    </div>
  )
}))
vi.mock('../MessageKnowledgeSearch', () => ({ MessageKnowledgeSearchToolTitle: () => null }))
vi.mock('../MessageMemorySearch', () => ({ MessageMemorySearchToolTitle: () => null }))
vi.mock('../MessageWebSearch', () => ({ MessageWebSearchToolTitle: () => null }))

describe('OpenCode native tool renderer dispatch', () => {
  it.each(['read', 'write', 'edit', 'apply_patch', 'bash'])(
    'renders native lower-case %s without changing its input',
    (name) => {
      render(
        <MessageTool
          block={
            {
              metadata: {
                rawMcpToolResponse: {
                  tool: { name, type: 'provider' },
                  toolCallId: `session:${name}`,
                  arguments: { filePath: 'C:/isolated/new.txt' },
                  status: 'pending'
                }
              }
            } as any
          }
        />
      )
      expect(screen.getByTestId('agent-tool')).toHaveTextContent(`${name}:C:/isolated/new.txt`)
    }
  )

  it('retains legacy capitalized tool rendering', () => {
    render(
      <MessageTool
        block={
          {
            metadata: {
              rawMcpToolResponse: {
                tool: { name: 'Write', type: 'provider' },
                arguments: { filePath: 'legacy' }
              }
            }
          } as any
        }
      />
    )
    expect(screen.getByTestId('agent-tool')).toHaveTextContent('Write:legacy')
  })
})
