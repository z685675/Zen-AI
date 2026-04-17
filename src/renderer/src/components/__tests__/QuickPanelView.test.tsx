import { configureStore } from '@reduxjs/toolkit'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React, { useEffect } from 'react'
import { Provider } from 'react-redux'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { QuickPanelListItem } from '../QuickPanel'
import { QuickPanelProvider, QuickPanelView, useQuickPanel } from '../QuickPanel'

// Mock the DynamicVirtualList component
vi.mock('@renderer/components/VirtualList', async (importOriginal) => {
  const mod = (await importOriginal()) as any
  return {
    ...mod,
    DynamicVirtualList: ({ ref, list, children, scrollerStyle }: any & { ref?: React.RefObject<any | null> }) => {
      // Expose a mock function for scrollToIndex
      React.useImperativeHandle(ref, () => ({
        scrollToIndex: vi.fn()
      }))

      // Render all items, not virtualized
      return (
        <div style={scrollerStyle}>
          {list.map((item: any, index: number) => (
            <div key={item.id || index}>{children(item, index)}</div>
          ))}
        </div>
      )
    }
  }
})

// Mock Redux store
const mockStore = configureStore({
  reducer: {
    settings: (state = { userTheme: { colorPrimary: '#1677ff' } }) => state
  }
})

function createList(length: number, prefix = 'Item', extra: Partial<QuickPanelListItem> = {}) {
  return Array.from({ length }, (_, i) => ({
    id: `${prefix}-${i + 1}`,
    label: `${prefix} ${i + 1}`,
    description: `${prefix} Description ${i + 1}`,
    icon: `${prefix} Icon ${i + 1}`,
    action: () => {},
    ...extra
  }))
}

type KeyStep = {
  key: string
  ctrlKey?: boolean
  expected: string | ((text: string) => boolean)
}

const PAGE_SIZE = 7

// 用于测试 open 行为的组�?function OpenPanelOnMount({ list }: { list: QuickPanelListItem[] }) {
  const quickPanel = useQuickPanel()
  useEffect(() => {
    quickPanel.open({
      title: 'Test Panel',
      list,
      symbol: 'test',
      pageSize: PAGE_SIZE
    })
  }, [list, quickPanel])
  return null
}

function wrapWithProviders(children: React.ReactNode) {
  return (
    <Provider store={mockStore}>
      <QuickPanelProvider>{children}</QuickPanelProvider>
    </Provider>
  )
}

describe('QuickPanelView', () => {
  beforeEach(() => {
    // 添加一个假�?.inputbar textarea �?document.body
    const inputbar = document.createElement('div')
    inputbar.className = 'inputbar'
    const textarea = document.createElement('textarea')
    inputbar.appendChild(textarea)
    document.body.appendChild(inputbar)
  })

  afterEach(() => {
    const inputbar = document.querySelector('.inputbar')
    if (inputbar) inputbar.remove()
  })

  describe('rendering', () => {
    it('should render without crashing when wrapped in QuickPanelProvider', () => {
      render(wrapWithProviders(<QuickPanelView setInputText={vi.fn()} />))

      // 检查面板容器是否存在且初始不可�?      const panel = screen.getByTestId('quick-panel')
      expect(panel.classList.contains('visible')).toBe(false)
    })

    it('should render list after open', async () => {
      const list = createList(100)

      render(
        wrapWithProviders(
          <>
            <QuickPanelView setInputText={vi.fn()} />
            <OpenPanelOnMount list={list} />
          </>
        )
      )

      // 检查面板可�?      const panel = screen.getByTestId('quick-panel')
      expect(panel.classList.contains('visible')).toBe(true)
      // 检查第一�?item 是否渲染
      expect(screen.getByText('Item 1')).toBeInTheDocument()
    })
  })

  describe('focusing', () => {
    // 执行一系列按键，检�?focused item 是否正确
    async function runKeySequenceAndCheck(panel: HTMLElement, sequence: KeyStep[]) {
      const user = userEvent.setup()
      for (const { key, ctrlKey, expected } of sequence) {
        let keyString = ''
        if (ctrlKey) keyString += '{Control>}'
        keyString += key.length === 1 ? key : `{${key}}`
        if (ctrlKey) keyString += '{/Control}'
        await user.keyboard(keyString)

        // 检查是否只有一�?focused item
        const focused = panel.querySelectorAll('.focused')
        expect(focused.length).toBe(1)
        // 检�?focused item 是否包含预期文本
        const text = focused[0].textContent || ''
        if (typeof expected === 'string') {
          expect(text).toContain(expected)
        } else {
          expect(expected(text)).toBe(true)
        }
      }
    }

    it('should not focus on any item after panel open by default', () => {
      const list = createList(100)

      render(
        wrapWithProviders(
          <>
            <QuickPanelView setInputText={vi.fn()} />
            <OpenPanelOnMount list={list} />
          </>
        )
      )

      // 检查是否没有任�?focused item
      const panel = screen.getByTestId('quick-panel')
      const focused = panel.querySelectorAll('.focused')
      expect(focused.length).toBe(0)

      // 检查第一�?item 存在但没�?focused �?      const item1 = screen.getByText('Item 1')
      expect(item1).toBeInTheDocument()
      const focusedItem1 = item1.closest('.focused')
      expect(focusedItem1).toBeNull()
    })

    it('should focus on the right item using ArrowUp, ArrowDown', async () => {
      const list = createList(100, 'Item')

      render(
        wrapWithProviders(
          <>
            <QuickPanelView setInputText={vi.fn()} />
            <OpenPanelOnMount list={list} />
          </>
        )
      )

      const keySequence = [
        { key: 'ArrowDown', expected: 'Item 1' }, // 从未选中状态按 ArrowDown 会选中第一�?        { key: 'ArrowUp', expected: 'Item 100' }, // 从第一个按 ArrowUp 会循环到最后一�?        { key: 'ArrowUp', expected: 'Item 99' },
        { key: 'ArrowDown', expected: 'Item 100' },
        { key: 'ArrowDown', expected: 'Item 1' } // 从最后一个按 ArrowDown 会循环到第一�?      ]

      await runKeySequenceAndCheck(screen.getByTestId('quick-panel'), keySequence)
    })

    it('should focus on the right item using PageUp, PageDown', async () => {
      const list = createList(100, 'Item')

      render(
        wrapWithProviders(
          <>
            <QuickPanelView setInputText={vi.fn()} />
            <OpenPanelOnMount list={list} />
          </>
        )
      )

      const keySequence = [
        { key: 'PageDown', expected: `Item ${PAGE_SIZE}` }, // 从未选中状态按 PageDown 会选中�?pageSize 个项�?        { key: 'PageUp', expected: 'Item 1' }, // PageUp 会选中第一�?        { key: 'ArrowUp', expected: 'Item 100' }, // 从第一个按 ArrowUp 会到最后一�?        { key: 'PageDown', expected: 'Item 100' }, // 从最后一个按 PageDown 仍然是最后一�?        { key: 'PageUp', expected: `Item ${100 - PAGE_SIZE}` } // PageUp 会向上翻页，从索�?9�?2，对应Item 93
      ]

      await runKeySequenceAndCheck(screen.getByTestId('quick-panel'), keySequence)
    })

    it('should focus on the right item using Ctrl+ArrowUp, Ctrl+ArrowDown', async () => {
      const list = createList(100, 'Item')

      render(
        wrapWithProviders(
          <>
            <QuickPanelView setInputText={vi.fn()} />
            <OpenPanelOnMount list={list} />
          </>
        )
      )

      const keySequence = [
        { key: 'ArrowDown', ctrlKey: true, expected: 'Item 1' }, // 从未选中状态按 Ctrl+ArrowDown 会选中第一�?        { key: 'ArrowDown', ctrlKey: true, expected: `Item ${PAGE_SIZE + 1}` }, // Ctrl+ArrowDown 会跳�?pageSize 个位�?        { key: 'ArrowUp', ctrlKey: true, expected: 'Item 1' }, // Ctrl+ArrowUp 会跳转回�?        { key: 'ArrowUp', ctrlKey: true, expected: 'Item 100' }, // 从第一个位置再�?Ctrl+ArrowUp 会循环到最�?        { key: 'ArrowDown', ctrlKey: true, expected: 'Item 1' } // 从最后位置按 Ctrl+ArrowDown 会循环到第一�?      ]

      await runKeySequenceAndCheck(screen.getByTestId('quick-panel'), keySequence)
    })
  })
})
