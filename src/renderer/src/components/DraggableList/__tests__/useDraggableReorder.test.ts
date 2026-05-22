import type { DropResult } from '@hello-pangea/dnd'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useDraggableReorder } from '../useDraggableReorder'

const createItem = (id: number) => ({ id: `item-${id}`, name: `Item ${id}` })
const originalList = [createItem(1), createItem(2), createItem(3), createItem(4), createItem(5)]

const createDropResult = (sourceIndex: number, destIndex: number | null): DropResult => ({
  reason: 'DROP',
  source: { index: sourceIndex, droppableId: 'droppable' },
  destination: destIndex === null ? null : { index: destIndex, droppableId: 'droppable' },
  combine: null,
  mode: 'FLUID',
  draggableId: String(sourceIndex),
  type: 'DEFAULT'
})

describe('useDraggableReorder', () => {
  it('reorders the full list when no filter is applied', () => {
    const onUpdate = vi.fn()
    const { result } = renderHook(() =>
      useDraggableReorder({
        originalList,
        filteredList: originalList,
        onUpdate,
        itemKey: 'id'
      })
    )

    act(() => {
      result.current.onDragEnd(createDropResult(0, 2))
    })

    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate.mock.calls[0][0].map((item) => item.id)).toEqual(['item-2', 'item-3', 'item-1', 'item-4', 'item-5'])
  })

  it('maps filtered indexes back to original indexes before reordering', () => {
    const onUpdate = vi.fn()
    const filteredList = [originalList[0], originalList[2], originalList[4]]
    const { result } = renderHook(() =>
      useDraggableReorder({
        originalList,
        filteredList,
        onUpdate,
        itemKey: 'id'
      })
    )

    act(() => {
      result.current.onDragEnd(createDropResult(2, 0))
    })

    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate.mock.calls[0][0].map((item) => item.id)).toEqual(['item-5', 'item-1', 'item-2', 'item-3', 'item-4'])
  })

  it('does not update when destination is null or unchanged', () => {
    const onUpdate = vi.fn()
    const { result } = renderHook(() =>
      useDraggableReorder({
        originalList,
        filteredList: originalList,
        onUpdate,
        itemKey: 'id'
      })
    )

    act(() => {
      result.current.onDragEnd(createDropResult(0, null))
      result.current.onDragEnd(createDropResult(1, 1))
    })

    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('exposes itemKey mapping for filtered lists', () => {
    const filteredList = [originalList[0], originalList[2], originalList[4]]
    const { result } = renderHook(() =>
      useDraggableReorder({
        originalList,
        filteredList,
        onUpdate: vi.fn(),
        itemKey: 'id'
      })
    )

    expect(result.current.itemKey(0)).toBe(0)
    expect(result.current.itemKey(1)).toBe(2)
    expect(result.current.itemKey(2)).toBe(4)
  })
})
