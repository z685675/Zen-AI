import { CloseOutlined } from '@ant-design/icons'
import type { DraggableProvided, DroppableProvided, DropResult } from '@hello-pangea/dnd'
import { DragDropContext, Draggable, Droppable } from '@hello-pangea/dnd'
import { OpenClawSidebarIcon } from '@renderer/components/Icons/SVGIcon'
import { ALL_SIDEBAR_ICONS, getAvailableSidebarIcons } from '@renderer/config/sidebar'
import { getSidebarIconLabel } from '@renderer/i18n/label'
import { useAppDispatch } from '@renderer/store'
import { setSidebarIcons } from '@renderer/store/settings'
import type { SidebarIcon } from '@renderer/types'
import { DEFAULT_OPENCODE_AGENT_AVATAR } from '@shared/config/agents'
import { message } from 'antd'
import {
  BarChart3,
  Code,
  FileSearch,
  Folder,
  Languages,
  LayoutGrid,
  MessageSquareQuote,
  MousePointerClick,
  NotepadText,
  Palette,
  Sparkle
} from 'lucide-react'
import type { FC, ReactNode } from 'react'
import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface SidebarIconsManagerProps {
  visibleIcons: SidebarIcon[]
  disabledIcons: SidebarIcon[]
  setVisibleIcons: (icons: SidebarIcon[]) => void
  setDisabledIcons: (icons: SidebarIcon[]) => void
}

const SidebarIconsManager: FC<SidebarIconsManagerProps> = ({
  visibleIcons: storedVisibleIcons,
  disabledIcons: storedDisabledIcons,
  setVisibleIcons,
  setDisabledIcons
}) => {
  const { t } = useTranslation()

  const dispatch = useAppDispatch()
  // Display and drag indices must use the same layout. Hidden entries must not
  // go through the visible-layout helper, which automatically adds the new assistant.
  const disabledIcons = useMemo(
    () => [...new Set(storedDisabledIcons)].filter((icon) => icon !== 'assistants' && ALL_SIDEBAR_ICONS.includes(icon)),
    [storedDisabledIcons]
  )
  const visibleIcons = useMemo(
    () => getAvailableSidebarIcons(storedVisibleIcons, disabledIcons),
    [storedVisibleIcons, disabledIcons]
  )
  const saveIcons = useCallback(
    (visible: SidebarIcon[], disabled: SidebarIcon[]) => {
      const orderedVisible = getAvailableSidebarIcons(visible, disabled)
      setVisibleIcons(orderedVisible)
      setDisabledIcons(disabled)
      dispatch(setSidebarIcons({ visible: orderedVisible, disabled }))
    },
    [dispatch, setVisibleIcons, setDisabledIcons]
  )

  const onDragEnd = useCallback(
    (result: DropResult) => {
      if (!result.destination) return

      const { source, destination } = result

      // 如果是chat图标且目标是disabled区域,则不允许移动并提示
      const draggedItem = source.droppableId === 'visible' ? visibleIcons[source.index] : disabledIcons[source.index]
      if (!draggedItem) return
      if (draggedItem === 'assistants' && destination.droppableId === 'disabled') {
        message.warning(t('settings.display.sidebar.chat.hiddenMessage'))
        return
      }

      if (source.droppableId === destination.droppableId) {
        const list = source.droppableId === 'visible' ? [...visibleIcons] : [...disabledIcons]
        const [removed] = list.splice(source.index, 1)
        list.splice(destination.index, 0, removed)

        if (source.droppableId === 'visible') {
          saveIcons(list, disabledIcons)
        } else {
          saveIcons(visibleIcons, list)
        }
        return
      }

      const sourceList = source.droppableId === 'visible' ? [...visibleIcons] : [...disabledIcons]
      const destList = destination.droppableId === 'visible' ? [...visibleIcons] : [...disabledIcons]

      const [removed] = sourceList.splice(source.index, 1)
      const targetList = destList.filter((icon) => icon !== removed)
      targetList.splice(destination.index, 0, removed)

      const newVisibleIcons = destination.droppableId === 'visible' ? targetList : sourceList
      const newDisabledIcons = destination.droppableId === 'disabled' ? targetList : sourceList

      saveIcons(newVisibleIcons, newDisabledIcons)
    },
    [visibleIcons, disabledIcons, saveIcons, t]
  )

  const onMoveIcon = useCallback(
    (icon: SidebarIcon, fromList: 'visible' | 'disabled') => {
      // 如果是chat图标且要移动到disabled列表,则不允许并提示
      if (icon === 'assistants' && fromList === 'visible') {
        message.warning(t('settings.display.sidebar.chat.hiddenMessage'))
        return
      }

      if (fromList === 'visible') {
        const newVisibleIcons = visibleIcons.filter((i) => i !== icon)
        const newDisabledIcons = disabledIcons.some((i) => i === icon) ? disabledIcons : [...disabledIcons, icon]

        saveIcons(newVisibleIcons, newDisabledIcons)
      } else {
        const newDisabledIcons = disabledIcons.filter((i) => i !== icon)
        const newVisibleIcons = visibleIcons.some((i) => i === icon) ? visibleIcons : [...visibleIcons, icon]

        saveIcons(newVisibleIcons, newDisabledIcons)
      }
    },
    [t, visibleIcons, disabledIcons, saveIcons]
  )

  // 使用useMemo缓存图标映射
  const iconMap = useMemo(
    () =>
      ({
        assistants: <MessageSquareQuote size={16} />,
        agents: <MousePointerClick size={16} />,
        store: <Sparkle size={16} />,
        paintings: <Palette size={16} />,
        usage: <BarChart3 size={16} />,
        new_assistant: (
          <span aria-hidden="true" className="text-base leading-none">
            {DEFAULT_OPENCODE_AGENT_AVATAR}
          </span>
        ),
        translate: <Languages size={16} />,
        minapp: <LayoutGrid size={16} />,
        knowledge: <FileSearch size={16} />,
        files: <Folder size={16} />,
        notes: <NotepadText size={16} />,
        code_tools: <Code size={16} />,
        openclaw: <OpenClawSidebarIcon style={{ width: 16, height: 16 }} />
      }) satisfies Record<SidebarIcon, ReactNode>,
    []
  )

  const renderIcon = (icon: SidebarIcon) => iconMap[icon] || <i className={`iconfont ${icon}`} />

  return (
    <DragDropContext onDragEnd={onDragEnd}>
      <IconSection>
        <IconColumn>
          <h4>{t('settings.display.sidebar.visible')}</h4>
          <Droppable droppableId="visible">
            {(provided: DroppableProvided) => (
              <IconList ref={provided.innerRef} {...provided.droppableProps}>
                {visibleIcons.map((icon, index) => (
                  <Draggable key={icon} draggableId={icon} index={index}>
                    {(provided: DraggableProvided) => (
                      <IconItem ref={provided.innerRef} {...provided.draggableProps} {...provided.dragHandleProps}>
                        <IconContent $deprecated={icon === 'agents'}>
                          {renderIcon(icon)}
                          <span>{getSidebarIconLabel(icon)}</span>
                        </IconContent>
                        {icon !== 'assistants' && (
                          <CloseButton onClick={() => onMoveIcon(icon, 'visible')}>
                            <CloseOutlined />
                          </CloseButton>
                        )}
                      </IconItem>
                    )}
                  </Draggable>
                ))}
                {provided.placeholder}
              </IconList>
            )}
          </Droppable>
        </IconColumn>
        <IconColumn>
          <h4>{t('settings.display.sidebar.disabled')}</h4>
          <Droppable droppableId="disabled">
            {(provided: DroppableProvided) => (
              <IconList ref={provided.innerRef} {...provided.droppableProps}>
                {disabledIcons.length === 0 ? (
                  <EmptyPlaceholder>{t('settings.display.sidebar.empty')}</EmptyPlaceholder>
                ) : (
                  disabledIcons.map((icon, index) => (
                    <Draggable key={icon} draggableId={icon} index={index}>
                      {(provided: DraggableProvided) => (
                        <IconItem ref={provided.innerRef} {...provided.draggableProps} {...provided.dragHandleProps}>
                          <IconContent $deprecated={icon === 'agents'}>
                            {renderIcon(icon)}
                            <span>{getSidebarIconLabel(icon)}</span>
                          </IconContent>
                          <CloseButton onClick={() => onMoveIcon(icon, 'disabled')}>
                            <CloseOutlined />
                          </CloseButton>
                        </IconItem>
                      )}
                    </Draggable>
                  ))
                )}
                {provided.placeholder}
              </IconList>
            )}
          </Droppable>
        </IconColumn>
      </IconSection>
    </DragDropContext>
  )
}

// Styled components remain the same
const IconSection = styled.div`
  display: flex;
  gap: 20px;
  padding: 10px;
  background: var(--color-background);
`

const IconColumn = styled.div`
  flex: 1;

  h4 {
    margin-bottom: 10px;
    color: var(--color-text);
    font-weight: normal;
  }
`

const IconList = styled.div`
  height: 400px;
  min-height: 400px;
  padding: 10px;
  background: var(--color-background-soft);
  border-radius: 8px;
  border: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
`

const IconItem = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  margin-bottom: 8px;
  background: var(--color-background);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  cursor: move;
`

const IconContent = styled.div<{ $deprecated?: boolean }>`
  display: flex;
  align-items: center;
  gap: 10px;

  .iconfont {
    font-size: 16px;
    color: var(--color-text);
  }

  span {
    color: ${({ $deprecated }) => ($deprecated ? 'var(--color-deprecated-assistant)' : 'var(--color-text)')};
  }
`

const CloseButton = styled.div`
  cursor: pointer;
  color: var(--color-text-2);
  opacity: 0;
  transition: all 0.2s;

  &:hover {
    color: var(--color-text);
  }

  ${IconItem}:hover & {
    opacity: 1;
  }
`

const EmptyPlaceholder = styled.div`
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  color: var(--color-text-2);
  text-align: center;
  padding: 20px;
  font-size: 14px;
`

export default SidebarIconsManager
