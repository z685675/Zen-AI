import type { ActionTool } from '@renderer/components/ActionTools'
import { useToolManager } from '@renderer/components/ActionTools'
import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

// 创建测试工具数据
const createTestTool = (overrides: Partial<ActionTool> = {}): ActionTool => ({
  id: 'test-tool',
  type: 'core',
  order: 10,
  icon: 'TestIcon',
  tooltip: 'Test Tool',
  ...overrides
})

describe('useToolManager', () => {
  describe('registerTool', () => {
    it('should register a new tool', () => {
      const { result } = renderHook(() => {
        const [tools, setTools] = useState<ActionTool[]>([])
        const { registerTool } = useToolManager(setTools)
        return { tools, registerTool }
      })

      const testTool = createTestTool()

      act(() => {
        result.current.registerTool(testTool)
      })

      expect(result.current.tools).toHaveLength(1)
      expect(result.current.tools[0]).toEqual(testTool)
    })

    it('should replace existing tool with same id', () => {
      const { result } = renderHook(() => {
        const [tools, setTools] = useState<ActionTool[]>([])
        const { registerTool } = useToolManager(setTools)
        return { tools, registerTool }
      })

      const originalTool = createTestTool({ tooltip: 'Original' })
      const updatedTool = createTestTool({ tooltip: 'Updated' })

      act(() => {
        result.current.registerTool(originalTool)
        result.current.registerTool(updatedTool)
      })

      expect(result.current.tools).toHaveLength(1)
      expect(result.current.tools[0]).toEqual(updatedTool)
    })

    it('should sort tools by order (descending)', () => {
      const { result } = renderHook(() => {
        const [tools, setTools] = useState<ActionTool[]>([])
        const { registerTool } = useToolManager(setTools)
        return { tools, registerTool }
      })

      const tool1 = createTestTool({ id: 'tool1', order: 10 })
      const tool2 = createTestTool({ id: 'tool2', order: 30 })
      const tool3 = createTestTool({ id: 'tool3', order: 20 })

      act(() => {
        result.current.registerTool(tool1)
        result.current.registerTool(tool2)
        result.current.registerTool(tool3)
      })

      // 应该�?order 降序排列
      expect(result.current.tools[0].id).toBe('tool2') // order: 30
      expect(result.current.tools[1].id).toBe('tool3') // order: 20
      expect(result.current.tools[2].id).toBe('tool1') // order: 10
    })

    it('should handle tools with children', () => {
      const { result } = renderHook(() => {
        const [tools, setTools] = useState<ActionTool[]>([])
        const { registerTool } = useToolManager(setTools)
        return { tools, registerTool }
      })

      const childTool = createTestTool({ id: 'child-tool', order: 5 })
      const parentTool = createTestTool({
        id: 'parent-tool',
        order: 15,
        children: [childTool]
      })

      act(() => {
        result.current.registerTool(parentTool)
      })

      expect(result.current.tools).toHaveLength(1)
      expect(result.current.tools[0]).toEqual(parentTool)
      expect(result.current.tools[0].children).toEqual([childTool])
    })

    it('should not modify state if setTools is not provided', () => {
      const { result } = renderHook(() => useToolManager(undefined))

      // 不应该抛出错�?      expect(() => {
        act(() => {
          result.current.registerTool(createTestTool())
        })
      }).not.toThrow()
    })
  })

  describe('removeTool', () => {
    it('should remove tool by id', () => {
      const { result } = renderHook(() => {
        const [tools, setTools] = useState<ActionTool[]>([createTestTool()])
        const { registerTool, removeTool } = useToolManager(setTools)
        return { tools, registerTool, removeTool }
      })

      expect(result.current.tools).toHaveLength(1)

      act(() => {
        result.current.removeTool('test-tool')
      })

      expect(result.current.tools).toHaveLength(0)
    })

    it('should not affect other tools when removing one', () => {
      const { result } = renderHook(() => {
        const toolsData = [
          createTestTool({ id: 'tool1' }),
          createTestTool({ id: 'tool2' }),
          createTestTool({ id: 'tool3' })
        ]
        const [tools, setTools] = useState<ActionTool[]>(toolsData)
        const { removeTool } = useToolManager(setTools)
        return { tools, removeTool }
      })

      expect(result.current.tools).toHaveLength(3)

      act(() => {
        result.current.removeTool('tool2')
      })

      expect(result.current.tools).toHaveLength(2)
      expect(result.current.tools[0].id).toBe('tool1')
      expect(result.current.tools[1].id).toBe('tool3')
    })

    it('should handle removing non-existent tool', () => {
      const { result } = renderHook(() => {
        const [tools, setTools] = useState<ActionTool[]>([createTestTool()])
        const { removeTool } = useToolManager(setTools)
        return { tools, removeTool }
      })

      expect(result.current.tools).toHaveLength(1)

      act(() => {
        result.current.removeTool('non-existent-tool')
      })

      expect(result.current.tools).toHaveLength(1) // 应该没有变化
    })

    it('should not modify state if setTools is not provided', () => {
      const { result } = renderHook(() => useToolManager(undefined))

      // 不应该抛出错�?      expect(() => {
        act(() => {
          result.current.removeTool('test-tool')
        })
      }).not.toThrow()
    })
  })

  describe('integration', () => {
    it('should handle register and remove operations together', () => {
      const { result } = renderHook(() => {
        const [tools, setTools] = useState<ActionTool[]>([])
        const { registerTool, removeTool } = useToolManager(setTools)
        return { tools, registerTool, removeTool }
      })

      const tool1 = createTestTool({ id: 'tool1' })
      const tool2 = createTestTool({ id: 'tool2' })

      // 注册两个工具
      act(() => {
        result.current.registerTool(tool1)
        result.current.registerTool(tool2)
      })

      expect(result.current.tools).toHaveLength(2)

      // 移除一个工�?      act(() => {
        result.current.removeTool('tool1')
      })

      expect(result.current.tools).toHaveLength(1)
      expect(result.current.tools[0].id).toBe('tool2')

      // 再次注册被移除的工具
      act(() => {
        result.current.registerTool(tool1)
      })

      expect(result.current.tools).toHaveLength(2)
    })
  })
})
