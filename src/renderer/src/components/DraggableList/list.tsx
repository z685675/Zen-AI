import type {
  DroppableProps,
  DropResult,
  OnDragEndResponder,
  OnDragStartResponder,
  ResponderProvided
} from '@hello-pangea/dnd'
import { DragDropContext, Draggable, Droppable } from '@hello-pangea/dnd'
import { droppableReorder } from '@renderer/utils'
import type { HTMLAttributes, Key } from 'react'
import { useCallback } from 'react'

interface Props<T> {
  list: T[]
  style?: React.CSSProperties
  listStyle?: React.CSSProperties
  listProps?: HTMLAttributes<HTMLDivElement>
  children: (item: T, index: number) => React.ReactNode
  itemKey?: keyof T | ((item: T) => Key)
  isDragDisabled?: (item: T, index: number) => boolean
  onUpdate: (list: T[]) => void
  onDragStart?: OnDragStartResponder
  onDragEnd?: OnDragEndResponder
  droppableProps?: Partial<DroppableProps>
}

function DraggableList<T>({
  children,
  list,
  style,
  listStyle,
  listProps,
  itemKey,
  isDragDisabled,
  droppableProps,
  onDragStart,
  onUpdate,
  onDragEnd
}: Props<T>) {
  const _onDragEnd = (result: DropResult, provided: ResponderProvided) => {
    onDragEnd?.(result, provided)
    if (result.destination) {
      const sourceIndex = result.source.index
      const destIndex = result.destination.index
      if (sourceIndex !== destIndex) {
        const reorderAgents = droppableReorder(list, sourceIndex, destIndex)
        onUpdate(reorderAgents)
      }
    }
  }

  const getId = useCallback(
    (item: T) => {
      if (typeof itemKey === 'function') return itemKey(item)
      if (itemKey) return item[itemKey] as Key
      if (typeof item === 'string') return item as Key
      if (item && typeof item === 'object' && 'id' in item) return item.id as Key
      return undefined
    },
    [itemKey]
  )

  return (
    <DragDropContext onDragStart={onDragStart} onDragEnd={_onDragEnd}>
      <Droppable droppableId="droppable" {...droppableProps}>
        {(provided) => (
          <div {...provided.droppableProps} ref={provided.innerRef} style={style}>
            <div {...listProps} className="draggable-list-container">
              {list.map((item, index) => {
                const draggableId = String(getId(item) ?? index)
                return (
                  <Draggable
                    key={`draggable_${draggableId}`}
                    draggableId={draggableId}
                    index={index}
                    isDragDisabled={isDragDisabled?.(item, index) ?? false}>
                    {(provided) => (
                      <div
                        ref={provided.innerRef}
                        {...provided.draggableProps}
                        {...provided.dragHandleProps}
                        style={{
                          ...listStyle,
                          ...provided.draggableProps.style,
                          marginBottom: 8
                        }}>
                        {children(item, index)}
                      </div>
                    )}
                  </Draggable>
                )
              })}
              {provided.placeholder}
            </div>
          </div>
        )}
      </Droppable>
    </DragDropContext>
  )
}

export default DraggableList
