import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import MessageTools from '../MessageTools'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'message.tools.assistantCreateFile.open_file': 'Open file',
        'message.tools.assistantCreateFile.open_folder': 'Reveal in folder',
        'message.tools.assistantCreateFile.title': 'File created',
        'message.tools.assistantCreateFile.verified': 'Verified'
      })[key] ?? key
  })
}))

vi.mock('antd', () => ({
  Button: ({ children }: any) => <button type="button">{children}</button>,
  Tag: ({ children }: any) => <span>{children}</span>,
  Tooltip: ({ children }: any) => <>{children}</>
}))

vi.mock('lucide-react', () => ({
  FileText: () => <span data-testid="file-icon" />,
  FolderOpen: () => <span data-testid="folder-icon" />,
  ShieldCheck: () => <span data-testid="shield-icon" />
}))

vi.mock('../MessageAgentTools/ClickableFilePath', () => ({
  ClickableFilePath: ({ displayName }: { displayName?: string }) => <span>{displayName}</span>
}))

vi.mock('../MessageMcpTool', () => ({
  default: () => <div data-testid="mcp-tool">MCP tool</div>
}))

vi.mock('../MessageTool', () => ({
  default: () => <div data-testid="normal-tool">Normal tool</div>
}))

describe('MessageTools', () => {
  it('renders assistant create_file result card before generic MCP renderer', () => {
    render(
      <MessageTools
        block={
          {
            metadata: {
              rawMcpToolResponse: {
                id: 'tool-1',
                tool: {
                  id: 'mcp__assistant__create_file',
                  name: 'mcp__assistant__create_file',
                  description: 'Create file',
                  type: 'mcp'
                },
                arguments: {},
                status: 'done',
                toolCallId: 'tool-1',
                response: JSON.stringify({
                  status: 'created',
                  path: 'C:\\Users\\tester\\Desktop\\report.docx',
                  format: 'docx',
                  size: 128,
                  verified: true
                })
              }
            }
          } as any
        }
      />
    )

    expect(screen.getByText('File created')).toBeInTheDocument()
    expect(screen.getByText('report.docx')).toBeInTheDocument()
    expect(screen.queryByTestId('mcp-tool')).not.toBeInTheDocument()
  })
})
