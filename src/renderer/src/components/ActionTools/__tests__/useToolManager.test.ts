import type { ActionTool } from '@renderer/components/ActionTools'
import { useToolManager } from '@renderer/components/ActionTools'
import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

const createTool = (overrides: Partial<ActionTool> = {}): ActionTool => ({
  id: 'test-tool',
  type: 'core',
  order: 10,
  icon: 'Icon',
  tooltip: 'Test Tool',
  ...overrides
})

describe('useToolManager', () => {
  it('registers tools and keeps them sorted by descending order', () => {
    const { result } = renderHook(() => {
      const [tools, setTools] = useState<ActionTool[]>([])
      return { tools, ...useToolManager(setTools) }
    })

    act(() => {
      result.current.registerTool(createTool({ id: 'tool-1', order: 10 }))
      result.current.registerTool(createTool({ id: 'tool-2', order: 30 }))
      result.current.registerTool(createTool({ id: 'tool-3', order: 20 }))
    })

    expect(result.current.tools.map((tool) => tool.id)).toEqual(['tool-2', 'tool-3', 'tool-1'])
  })

  it('replaces an existing tool with the same id', () => {
    const { result } = renderHook(() => {
      const [tools, setTools] = useState<ActionTool[]>([])
      return { tools, ...useToolManager(setTools) }
    })

    act(() => {
      result.current.registerTool(createTool({ id: 'tool-1', tooltip: 'Original' }))
      result.current.registerTool(createTool({ id: 'tool-1', tooltip: 'Updated' }))
    })

    expect(result.current.tools).toHaveLength(1)
    expect(result.current.tools[0].tooltip).toBe('Updated')
  })

  it('removes only the requested tool', () => {
    const { result } = renderHook(() => {
      const [tools, setTools] = useState<ActionTool[]>([
        createTool({ id: 'tool-1' }),
        createTool({ id: 'tool-2' }),
        createTool({ id: 'tool-3' })
      ])
      return { tools, ...useToolManager(setTools) }
    })

    act(() => {
      result.current.removeTool('tool-2')
    })

    expect(result.current.tools.map((tool) => tool.id)).toEqual(['tool-1', 'tool-3'])
  })

  it('does not throw when no state setter is provided', () => {
    const { result } = renderHook(() => useToolManager(undefined))

    expect(() => {
      act(() => {
        result.current.registerTool(createTool())
        result.current.removeTool('missing-tool')
      })
    }).not.toThrow()
  })
})
