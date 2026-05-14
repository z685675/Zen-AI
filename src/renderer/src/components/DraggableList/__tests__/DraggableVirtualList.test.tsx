import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { DraggableVirtualList } from '../'

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({
      llm: {
        settings: {}
      }
    })
  }
}))

vi.mock('@hello-pangea/dnd', () => ({
  __esModule: true,
  DragDropContext: ({ children, onDragEnd, onDragStart }) => {
    window.triggerOnDragEnd = (result = { source: { index: 0 }, destination: { index: 1 } }, provided = {}) => {
      onDragEnd?.(result, provided)
    }
    window.triggerOnDragStart = (result = { source: { index: 0 } }, provided = {}) => {
      onDragStart?.(result, provided)
    }
    return <div data-testid="drag-drop-context">{children}</div>
  },
  Droppable: ({ children, renderClone }) => (
    <div data-testid="droppable">
      {renderClone &&
        renderClone({ draggableProps: {}, dragHandleProps: {}, innerRef: vi.fn() }, {}, { source: { index: 0 } })}
      {children({ droppableProps: {}, innerRef: vi.fn() })}
    </div>
  ),
  Draggable: ({ children, draggableId, index }) => (
    <div data-testid={`draggable-${draggableId}-${index}`}>
      {children({ draggableProps: {}, dragHandleProps: {}, innerRef: vi.fn() }, {})}
    </div>
  )
}))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, getScrollElement }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 50,
        size: 50
      })),
    getTotalSize: () => count * 50,
    measureElement: vi.fn(),
    scrollToIndex: vi.fn(),
    scrollToOffset: vi.fn(),
    scrollElement: getScrollElement(),
    measure: vi.fn(),
    resizeItem: vi.fn(),
    getVirtualIndexes: () => Array.from({ length: count }, (_, i) => i)
  })
}))

vi.mock('@renderer/components/Scrollbar', () => ({
  __esModule: true,
  default: ({ ref, children, ...props }) => (
    <div ref={ref} {...props} data-testid="scrollbar">
      {children}
    </div>
  )
}))

declare global {
  interface Window {
    triggerOnDragEnd: (result?: any, provided?: any) => void
    triggerOnDragStart: (result?: any, provided?: any) => void
  }
}

describe('DraggableVirtualList', () => {
  const sampleList = [
    { id: 'a', name: 'Item A' },
    { id: 'b', name: 'Item B' },
    { id: 'c', name: 'Item C' }
  ]

  it('renders visible items plus the drag clone', () => {
    render(
      <DraggableVirtualList list={sampleList} onUpdate={() => {}}>
        {(item) => <div data-testid="test-item">{item.name}</div>}
      </DraggableVirtualList>
    )

    const items = screen.getAllByTestId('test-item')
    expect(items).toHaveLength(sampleList.length + 1)
    expect(items[0]).toHaveTextContent('Item A')
    expect(items[1]).toHaveTextContent('Item A')
    expect(items[2]).toHaveTextContent('Item B')
    expect(items[3]).toHaveTextContent('Item C')
  })

  it('renders no items when the list is empty', () => {
    render(
      <DraggableVirtualList list={[]} onUpdate={() => {}}>
        {/* @ts-ignore test helper */}
        {(item) => <div data-testid="test-item">{item.name}</div>}
      </DraggableVirtualList>
    )

    expect(screen.queryAllByTestId('test-item')).toHaveLength(0)
  })

  it('calls onUpdate with the reordered list after drag end', () => {
    const onUpdate = vi.fn()
    render(
      <DraggableVirtualList list={sampleList} onUpdate={onUpdate}>
        {(item) => <div>{item.name}</div>}
      </DraggableVirtualList>
    )

    window.triggerOnDragEnd({ source: { index: 0 }, destination: { index: 2 } })

    expect(onUpdate).toHaveBeenCalledWith([sampleList[1], sampleList[2], sampleList[0]])
  })

  it('forwards drag start/end callbacks and ignores missing destinations', () => {
    const onUpdate = vi.fn()
    const onDragStart = vi.fn()
    const onDragEnd = vi.fn()

    render(
      <DraggableVirtualList list={sampleList} onUpdate={onUpdate} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        {(item) => <div>{item.name}</div>}
      </DraggableVirtualList>
    )

    window.triggerOnDragStart()
    window.triggerOnDragEnd({ source: { index: 0 }, destination: null })

    expect(onDragStart).toHaveBeenCalledTimes(1)
    expect(onDragEnd).toHaveBeenCalledTimes(1)
    expect(onUpdate).not.toHaveBeenCalled()
  })
})
