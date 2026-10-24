import zh from '@renderer/i18n/locales/zh-cn.json'
import type { ThinkingMessageBlock, ToolMessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ waiting: new Set<string>(), confirm: vi.fn() }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@renderer/components/ErrorBoundary', () => ({ ErrorBoundary: ({ children }: any) => children }))
vi.mock('../Tools/hooks/useToolApproval', () => ({
  useToolApproval: (block: any) => ({ isWaiting: mocks.waiting.has(block.id) })
}))
vi.mock('../Tools/ToolHeader', () => ({ default: ({ block }: any) => <span>{block.id}</span> }))
vi.mock('../Tools/MessageAgentTools/GenericTools', () => ({
  getEffectiveStatus: (status: string, waiting: boolean) => (waiting ? 'waiting' : status),
  getToolHasError: (response: any) => response?.status === 'error' || response?.response?.isError === true
}))
vi.mock('../Blocks/ToolBlock', () => ({
  default: ({ block }: any) => (
    <div>
      <span>details-{block.id}</span>
      {mocks.waiting.has(block.id) && (
        <button type="button" onClick={mocks.confirm}>
          approve-{block.id}
        </button>
      )}
    </div>
  )
}))
import NativeActivity, { collectNativeActivity } from '../Blocks/NativeActivity'

const tool = (id: string, status = 'done') =>
  ({
    id,
    type: MessageBlockType.TOOL,
    metadata: { rawMcpToolResponse: { status, tool: { name: 'create_file' } } }
  }) as ToolMessageBlock
const thinking = {
  id: 'thought',
  type: MessageBlockType.THINKING,
  content: 'private reasoning'
} as ThinkingMessageBlock
beforeEach(() => {
  mocks.waiting.clear()
  vi.clearAllMocks()
})

describe('compact native execution activity', () => {
  it('provides Chinese activity labels at the actual lookup path', () => {
    expect(zh.nativeActivity.thinking).toBe('思考')
    expect(zh.nativeActivity.finished).toContain('思考与执行')
  })
  it('does not turn an empty thinking placeholder into falsely visible response activity', () => {
    expect(
      collectNativeActivity([
        { ...thinking, content: '' },
        { ...thinking, id: 'spaces', content: '  \n' }
      ])
    ).toEqual([])
    expect(collectNativeActivity([thinking, tool('actual-call')])).toHaveLength(2)
  })
  it('keeps detailed thinking, failures and file-tool output collapsed by default', () => {
    render(<NativeActivity blocks={[tool('write'), thinking, tool('retry', 'error')]} processing={false} />)
    expect(screen.getByRole('button', { name: 'nativeActivity.finished' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('details-write')).not.toBeInTheDocument()
    expect(screen.queryByText('private reasoning')).not.toBeInTheDocument()
    expect(screen.getByText('nativeActivity.failures')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'nativeActivity.finished' }))
    expect(screen.getByText('details-write')).toBeInTheDocument()
    expect(screen.getByText('private reasoning')).toBeInTheDocument()
  })
  it('keeps actual approval controls outside the collapsed log and switches current tool status', () => {
    mocks.waiting.add('permission')
    const { rerender } = render(<NativeActivity blocks={[tool('permission', 'pending')]} processing />)
    expect(screen.getByRole('button', { name: 'nativeActivity.running' })).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'approve-permission' }))
    expect(mocks.confirm).toHaveBeenCalledOnce()
    mocks.waiting.clear()
    rerender(<NativeActivity blocks={[tool('permission'), tool('next', 'invoking')]} processing />)
    expect(screen.queryByRole('button', { name: 'approve-permission' })).not.toBeInTheDocument()
    expect(screen.getByText('next')).toBeInTheDocument()
    expect(screen.queryByText('details-next')).not.toBeInTheDocument()
    rerender(<NativeActivity blocks={[tool('permission'), tool('next')]} processing={false} />)
    expect(screen.queryByText('next')).not.toBeInTheDocument()
  })
})
