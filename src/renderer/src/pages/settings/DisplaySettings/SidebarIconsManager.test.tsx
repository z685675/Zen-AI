import { act, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), drag: undefined as undefined | ((result: any) => void) }))
vi.mock('@renderer/store', () => ({ useAppDispatch: () => mocks.dispatch }))
vi.mock('@renderer/store/settings', () => ({
  setSidebarIcons: (icons: unknown) => ({ type: 'sidebar', payload: icons })
}))
vi.mock('@renderer/i18n/label', () => ({ getSidebarIconLabel: (icon: string) => icon }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))
vi.mock('@hello-pangea/dnd', () => ({
  DragDropContext: ({ children, onDragEnd }: { children: ReactNode; onDragEnd: typeof mocks.drag }) => {
    mocks.drag = onDragEnd
    return children
  },
  Droppable: ({ children, droppableId }: any) => (
    <section data-testid={droppableId}>
      {children({ innerRef: vi.fn(), droppableProps: {}, placeholder: null })}
    </section>
  ),
  Draggable: ({ children }: any) => children({ innerRef: vi.fn(), draggableProps: {}, dragHandleProps: {} })
}))

import SidebarIconsManager from './SidebarIconsManager'

describe('sidebar settings use the displayed layout for drag operations', () => {
  beforeEach(() => mocks.dispatch.mockClear())

  it('does not create a ghost new assistant in the hidden column', () => {
    render(
      <SidebarIconsManager
        visibleIcons={['assistants', 'agents']}
        disabledIcons={['notes']}
        setVisibleIcons={vi.fn()}
        setDisabledIcons={vi.fn()}
      />
    )
    expect(within(screen.getByTestId('visible')).getByText('new_assistant')).toBeInTheDocument()
    expect(within(screen.getByTestId('disabled')).queryByText('new_assistant')).not.toBeInTheDocument()
    expect(screen.getAllByText('new_assistant')).toHaveLength(1)
    expect(within(screen.getByTestId('visible')).getByText('❤️')).toBeInTheDocument()
  })

  it('hides the actual dragged entry after an old saved layout is reordered', () => {
    const setVisibleIcons = vi.fn()
    const setDisabledIcons = vi.fn()
    render(
      <SidebarIconsManager
        visibleIcons={['assistants', 'agents', 'files']}
        disabledIcons={['notes']}
        setVisibleIcons={setVisibleIcons}
        setDisabledIcons={setDisabledIcons}
      />
    )
    act(() =>
      mocks.drag?.({
        source: { droppableId: 'visible', index: 1 },
        destination: { droppableId: 'disabled', index: 1 }
      })
    )
    expect(setVisibleIcons).toHaveBeenCalledWith(['assistants', 'files', 'agents'])
    expect(setDisabledIcons).toHaveBeenCalledWith(['notes', 'new_assistant'])
  })

  it('restores the new assistant immediately after chat without restoring the hidden old entry', () => {
    const setVisibleIcons = vi.fn()
    const setDisabledIcons = vi.fn()
    render(
      <SidebarIconsManager
        visibleIcons={['assistants', 'files']}
        disabledIcons={['new_assistant', 'agents']}
        setVisibleIcons={setVisibleIcons}
        setDisabledIcons={setDisabledIcons}
      />
    )
    act(() =>
      mocks.drag?.({
        source: { droppableId: 'disabled', index: 0 },
        destination: { droppableId: 'visible', index: 2 }
      })
    )
    expect(setVisibleIcons).toHaveBeenCalledWith(['assistants', 'new_assistant', 'files'])
    expect(setDisabledIcons).toHaveBeenCalledWith(['agents'])
  })
})
