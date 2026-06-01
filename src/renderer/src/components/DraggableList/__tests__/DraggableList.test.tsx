/// <reference types="@vitest/browser/context" />

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DraggableList } from '../'

const dragStyleState = vi.hoisted(() => ({
  enabled: false
}))

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({
      llm: { settings: {} }
    })
  }
}))

vi.mock('@hello-pangea/dnd', () => {
  return {
    __esModule: true,
    DragDropContext: ({ children, onDragEnd, onDragStart }: any) => {
      window.triggerOnDragEnd = (result = { source: { index: 0 }, destination: { index: 1 } }, provided = {}) => {
        onDragEnd?.(result, provided)
      }
      window.triggerOnDragStart = (start = { source: { index: 0 } }, provided = {}) => {
        onDragStart?.(start, provided)
      }
      return <div data-testid="drag-drop-context">{children}</div>
    },
    Droppable: ({ children }: any) => (
      <div data-testid="droppable">
        {children({ droppableProps: {}, innerRef: () => {}, placeholder: <div data-testid="placeholder" /> })}
      </div>
    ),
    Draggable: ({ children, draggableId, index }: any) => {
      const style = dragStyleState.enabled
        ? { transform: index === 0 ? 'translate(32px, 48px)' : 'translate3d(24px, 56px, 0px)' }
        : undefined

      return (
        <div data-testid={`draggable-${draggableId}-${index}`}>
          {children({
            draggableProps: { style },
            dragHandleProps: {},
            innerRef: () => {}
          })}
        </div>
      )
    }
  }
})

declare global {
  interface Window {
    triggerOnDragEnd: (result?: any, provided?: any) => void
    triggerOnDragStart: (start?: any, provided?: any) => void
  }
}

describe('DraggableList', () => {
  const objectList = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' }
  ]

  beforeEach(() => {
    dragStyleState.enabled = false
  })

  it('renders all items', () => {
    render(
      <DraggableList list={objectList} onUpdate={() => {}}>
        {(item) => <div data-testid="item">{item.name}</div>}
      </DraggableList>
    )

    expect(screen.getAllByTestId('item').map((node) => node.textContent)).toEqual(['A', 'B', 'C'])
  })

  it('calls onUpdate with reordered list after drag end', () => {
    const onUpdate = vi.fn()

    render(
      <DraggableList list={objectList} onUpdate={onUpdate}>
        {(item) => <div data-testid="item">{item.name}</div>}
      </DraggableList>
    )

    window.triggerOnDragEnd({ source: { index: 0 }, destination: { index: 2 } }, {})
    expect(onUpdate).toHaveBeenCalledWith([objectList[1], objectList[2], objectList[0]])
  })

  it('calls drag lifecycle callbacks', () => {
    const onDragStart = vi.fn()
    const onDragEnd = vi.fn()
    const result = { source: { index: 0 }, destination: { index: 1 } }
    const provided = { announce: vi.fn() }

    render(
      <DraggableList list={objectList} onUpdate={() => {}} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        {(item) => <div data-testid="item">{item.name}</div>}
      </DraggableList>
    )

    window.triggerOnDragStart({ source: { index: 0 } }, provided)
    window.triggerOnDragEnd(result, provided)

    expect(onDragStart).toHaveBeenCalledTimes(1)
    expect(onDragEnd).toHaveBeenCalledWith(result, provided)
  })

  it('does not update when dropped in the same position', () => {
    const onUpdate = vi.fn()

    render(
      <DraggableList list={objectList} onUpdate={onUpdate}>
        {(item) => <div data-testid="item">{item.name}</div>}
      </DraggableList>
    )

    window.triggerOnDragEnd({ source: { index: 1 }, destination: { index: 1 } }, {})
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('handles string items without explicit ids', () => {
    const list = ['A', 'B', 'C']
    const onUpdate = vi.fn()

    render(
      <DraggableList list={list} onUpdate={onUpdate}>
        {(item) => <div data-testid="item">{item}</div>}
      </DraggableList>
    )

    window.triggerOnDragEnd({ source: { index: 0 }, destination: { index: 2 } }, {})
    expect(onUpdate).toHaveBeenCalledWith(['B', 'C', 'A'])
  })

  it('can constrain drag movement to the vertical axis', () => {
    dragStyleState.enabled = true

    render(
      <DraggableList list={objectList} onUpdate={() => {}} constrainDragAxis="vertical">
        {(item) => <div data-testid="item">{item.name}</div>}
      </DraggableList>
    )

    expect(screen.getAllByTestId('item')[0].parentElement).toHaveStyle({ transform: 'translate(0px, 48px)' })
  })

  it('renders placeholder and matches snapshot', () => {
    const { container } = render(
      <DraggableList list={objectList} onUpdate={() => {}}>
        {(item) => <div data-testid="item">{item.name}</div>}
      </DraggableList>
    )

    expect(screen.getByTestId('placeholder')).toBeInTheDocument()
    expect(container).toMatchSnapshot()
  })
})
