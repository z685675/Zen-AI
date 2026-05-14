import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React, { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { QuickPanelListItem } from '../QuickPanel'
import { QuickPanelProvider, QuickPanelView, useQuickPanel } from '../QuickPanel'

vi.mock('@renderer/components/VirtualList', () => ({
  DynamicVirtualList: React.forwardRef<any, any>(function MockDynamicVirtualList(props, ref) {
    const { list, children, scrollerStyle } = props
    React.useImperativeHandle(ref, () => ({
      scrollToIndex: vi.fn()
    }))
    return (
      <div style={scrollerStyle}>
        {list.map((item: any, index: number) => (
          <div key={item.id ?? index}>{children(item, index)}</div>
        ))}
      </div>
    )
  })
}))

vi.mock('@renderer/hooks/useUserTheme', () => ({
  default: () => ({
    colorPrimary: {
      alpha: () => ({
        toString: () => 'rgba(22, 119, 255, 0.15)'
      })
    }
  })
}))

vi.mock('@renderer/hooks/useTimer', () => ({
  useTimer: () => ({
    setTimeoutTimer: (_key: string, cb: () => void) => cb()
  })
}))

vi.mock('@renderer/config/constant', () => ({
  isMac: false
}))

vi.mock('@renderer/utils', () => ({
  classNames: (...args: any[]) => args.filter(Boolean).join(' ')
}))

vi.mock('i18next', () => ({
  t: (key: string, fallback?: string) => fallback ?? key
}))

vi.mock('antd', () => ({
  Flex: ({ children }: React.PropsWithChildren) => <div>{children}</div>
}))

vi.mock('@ant-design/icons', () => ({
  RightOutlined: () => <span data-testid="right-outlined">{'>'}</span>
}))

vi.mock('lucide-react', () => ({
  Check: () => <span data-testid="check-icon">check</span>
}))

function createList(length: number): QuickPanelListItem[] {
  return Array.from({ length }, (_, index) => ({
    label: `Item ${index + 1}`,
    description: `Description ${index + 1}`,
    icon: `Icon ${index + 1}`,
    action: vi.fn()
  }))
}

function OpenPanelOnMount({ list }: { list: QuickPanelListItem[] }) {
  const quickPanel = useQuickPanel()

  useEffect(() => {
    quickPanel.open({
      title: 'Test Panel',
      list,
      symbol: '/',
      pageSize: 7
    })
  }, [list, quickPanel])

  return null
}

describe('QuickPanelView', () => {
  beforeEach(() => {
    const inputbar = document.createElement('div')
    inputbar.className = 'inputbar'
    inputbar.id = 'inputbar'
    inputbar.appendChild(document.createElement('textarea'))
    document.body.appendChild(inputbar)
  })

  afterEach(() => {
    document.querySelector('.inputbar')?.remove()
  })

  const renderPanel = (list?: QuickPanelListItem[]) =>
    render(
      <QuickPanelProvider>
        <QuickPanelView setInputText={vi.fn()} />
        {list ? <OpenPanelOnMount list={list} /> : null}
      </QuickPanelProvider>
    )

  it('renders hidden by default', () => {
    renderPanel()

    expect(screen.getByTestId('quick-panel')).not.toHaveClass('visible')
  })

  it('renders list items after opening', async () => {
    renderPanel(createList(3))

    const panel = screen.getByTestId('quick-panel')
    expect(panel).toHaveClass('visible')
    expect(await screen.findByText('Item 1')).toBeInTheDocument()
    expect(screen.getByText('Item 3')).toBeInTheDocument()
  })

  it('navigates items with keyboard navigation', async () => {
    const list = createList(3)
    const firstAction = vi.fn()
    const secondAction = vi.fn()
    list[0].action = firstAction
    list[1].action = secondAction

    renderPanel(list)
    const user = userEvent.setup()

    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Enter}')
    expect(firstAction).toHaveBeenCalledTimes(1)
    expect(secondAction).not.toHaveBeenCalled()

    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Enter}')
    expect(secondAction).toHaveBeenCalledTimes(1)

    await user.keyboard('{ArrowUp}')
    await user.keyboard('{Enter}')
    expect(firstAction).toHaveBeenCalledTimes(2)
  })

  it('invokes the focused item action on Enter', async () => {
    const list = createList(2)
    const firstAction = vi.fn()
    list[0].action = firstAction

    renderPanel(list)
    const user = userEvent.setup()

    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Enter}')

    expect(firstAction).toHaveBeenCalled()
  })
})
