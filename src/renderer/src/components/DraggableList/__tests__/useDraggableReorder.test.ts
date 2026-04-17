import type { DropResult } from '@hello-pangea/dnd'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useDraggableReorder } from '../useDraggableReorder'

// 辅助函数和模拟数�?const createMockItem = (id: number) => ({ id: `item-${id}`, name: `Item ${id}` })
const mockOriginalList = [createMockItem(1), createMockItem(2), createMockItem(3), createMockItem(4), createMockItem(5)]

/**
 * 创建一个符�?DropResult 类型的模拟对象�? * @param sourceIndex - 拖拽源的视图索引
 * @param destIndex - 拖拽目标的视图索�? * @param draggableId - 被拖拽项的唯一 ID，应与其 itemKey 对应
 */
const createMockDropResult = (sourceIndex: number, destIndex: number | null, draggableId: string): DropResult => ({
  reason: 'DROP',
  source: { index: sourceIndex, droppableId: 'droppable' },
  destination: destIndex !== null ? { index: destIndex, droppableId: 'droppable' } : null,
  combine: null,
  mode: 'FLUID',
  draggableId,
  type: 'DEFAULT'
})

describe('useDraggableReorder', () => {
  describe('reorder', () => {
    it('should correctly reorder the list when it is not filtered', () => {
      const onUpdate = vi.fn()
      const { result } = renderHook(() =>
        useDraggableReorder({
          originalList: mockOriginalList,
          filteredList: mockOriginalList, // 列表未过�?          onUpdate,
          itemKey: 'id'
        })
      )

      // 模拟将第一�?(视图索引 0, 原始索引 0) 拖到第三项的位置 (视图索引 2)
      // 在未过滤列表中，itemKey(0) 返回 0
      const dropResult = createMockDropResult(0, 2, '0')

      act(() => {
        result.current.onDragEnd(dropResult)
      })

      expect(onUpdate).toHaveBeenCalledTimes(1)
      const newList = onUpdate.mock.calls[0][0]
      // 原始: [1, 2, 3, 4, 5] -> 拖拽后预�? [2, 3, 1, 4, 5]
      expect(newList.map((i) => i.id)).toEqual(['item-2', 'item-3', 'item-1', 'item-4', 'item-5'])
    })

    it('should correctly reorder the original list when the list is filtered', () => {
      const onUpdate = vi.fn()
      // 过滤后只剩下奇数�? [item-1, item-3, item-5]
      const filteredList = [mockOriginalList[0], mockOriginalList[2], mockOriginalList[4]]

      const { result } = renderHook(() =>
        useDraggableReorder({
          originalList: mockOriginalList,
          filteredList,
          onUpdate,
          itemKey: 'id'
        })
      )

      // 在过滤后的列表中，将最后一�?'item-5' (视图索引 2) 拖到第一�?'item-1' (视图索引 0) 的位�?      // 'item-5' 的原始索引是 4, 所�?itemKey(2) 返回 4
      const dropResult = createMockDropResult(2, 0, '4')

      act(() => {
        result.current.onDragEnd(dropResult)
      })

      expect(onUpdate).toHaveBeenCalledTimes(1)
      const newList = onUpdate.mock.calls[0][0]
      // 原始: [1, 2, 3, 4, 5]
      // 拖拽后预�? 'item-5' 移动�?'item-1' 的位�?-> [5, 1, 2, 3, 4]
      expect(newList.map((i) => i.id)).toEqual(['item-5', 'item-1', 'item-2', 'item-3', 'item-4'])
    })
  })

  describe('onUpdate', () => {
    it('should not call onUpdate if destination is null', () => {
      const onUpdate = vi.fn()
      const { result } = renderHook(() =>
        useDraggableReorder({
          originalList: mockOriginalList,
          filteredList: mockOriginalList,
          onUpdate,
          itemKey: 'id'
        })
      )

      // 模拟拖拽到列表外
      const dropResult = createMockDropResult(0, null, '0')

      act(() => {
        result.current.onDragEnd(dropResult)
      })

      expect(onUpdate).not.toHaveBeenCalled()
    })

    it('should not call onUpdate if source and destination are the same', () => {
      const onUpdate = vi.fn()
      const { result } = renderHook(() =>
        useDraggableReorder({
          originalList: mockOriginalList,
          filteredList: mockOriginalList,
          onUpdate,
          itemKey: 'id'
        })
      )

      // 模拟拖拽后放回原�?      const dropResult = createMockDropResult(1, 1, '1')

      act(() => {
        result.current.onDragEnd(dropResult)
      })

      expect(onUpdate).not.toHaveBeenCalled()
    })
  })

  describe('itemKey', () => {
    it('should return the correct original index from a filtered list index', () => {
      const onUpdate = vi.fn()
      // 过滤后只剩下奇数�? [item-1, item-3, item-5]
      const filteredList = [mockOriginalList[0], mockOriginalList[2], mockOriginalList[4]]

      const { result } = renderHook(() =>
        useDraggableReorder({
          originalList: mockOriginalList,
          filteredList,
          onUpdate,
          itemKey: 'id'
        })
      )

      // 视图索引 0 -> 'item-1' -> 原始索引 0
      expect(result.current.itemKey(0)).toBe(0)
      // 视图索引 1 -> 'item-3' -> 原始索引 2
      expect(result.current.itemKey(1)).toBe(2)
      // 视图索引 2 -> 'item-5' -> 原始索引 4
      expect(result.current.itemKey(2)).toBe(4)
    })
  })
})
