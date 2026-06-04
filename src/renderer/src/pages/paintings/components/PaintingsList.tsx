import { DeleteOutlined, PlusOutlined, UpOutlined } from '@ant-design/icons'
import { DraggableList } from '@renderer/components/DraggableList'
import Scrollbar from '@renderer/components/Scrollbar'
import { usePaintings } from '@renderer/hooks/usePaintings'
import FileManager from '@renderer/services/FileManager'
import type { Painting, PaintingsState } from '@renderer/types'
import { classNames } from '@renderer/utils'
import { Popconfirm, Tooltip } from 'antd'
import type { FC } from 'react'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface PaintingsListProps {
  paintings: Painting[]
  selectedPainting: Painting | null
  onSelectPainting: (painting: Painting) => void
  onDeletePainting: (painting: Painting) => void
  onNewPainting: () => void
  namespace: keyof PaintingsState
  loadingPaintingIds?: Set<string>
}

const PaintingsList: FC<PaintingsListProps> = ({
  paintings,
  selectedPainting,
  onSelectPainting,
  onDeletePainting,
  onNewPainting,
  namespace,
  loadingPaintingIds
}) => {
  const { t } = useTranslation()
  const [dragging, setDragging] = useState(false)
  const [showScrollTop, setShowScrollTop] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)
  const { updatePaintings } = usePaintings()
  const getPaintingIndexLabel = (painting: Painting) => String(paintings.length - paintings.indexOf(painting))
  const getSourceLabel = (painting: Painting) => {
    if (!painting.sourcePaintingId) {
      return ''
    }

    const sourcePainting = paintings.find((item) => item.id === painting.sourcePaintingId)
    if (!sourcePainting) {
      return t('paintings.source_deleted')
    }

    const sourceIndex = getPaintingIndexLabel(sourcePainting)
    const sourceImageIndex = painting.sourceImageIndex ?? 0
    const sourceImageCount = painting.sourceImageCount ?? sourcePainting.files.length
    const sourceImageSuffix = sourceImageCount > 1 ? `-${sourceImageIndex + 1}` : ''
    return `${t('paintings.source')}${sourceIndex}${sourceImageSuffix}`
  }
  const getCanvasLabel = (painting: Painting) => {
    const indexLabel = getPaintingIndexLabel(painting)
    const sourceLabel = getSourceLabel(painting)
    return sourceLabel ? `${indexLabel}--${sourceLabel}` : indexLabel
  }
  const handleScroll = useCallback(() => {
    setShowScrollTop((listRef.current?.scrollTop ?? 0) > 240)
  }, [])
  const scrollToTop = useCallback(() => {
    listRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  return (
    <ListShell>
      <Container ref={listRef} onScroll={handleScroll} style={{ paddingBottom: dragging ? 80 : 10 }}>
      {!dragging && (
        <>
          <Tooltip title={t('paintings.drag_reorder_hint')} placement="left">
            <NewPaintingButton onClick={onNewPainting}>
              <PlusOutlined />
            </NewPaintingButton>
          </Tooltip>
          {paintings.length > 1 && <DragHint>{t('paintings.drag_reorder_hint')}</DragHint>}
        </>
      )}
      <DraggableList
        list={paintings}
        onUpdate={(value) => updatePaintings(namespace, value)}
        onDragStart={() => setDragging(true)}
        onDragEnd={() => setDragging(false)}
        constrainDragAxis="vertical"
        droppableProps={{ direction: 'vertical' }}
        listStyle={{ width: 84 }}
        style={{ width: '100%' }}
        listProps={{
          style: {
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center'
          }
        }}>
        {(item: Painting) => (
          <CanvasWrapper key={item.id}>
            <Canvas
              className={classNames(selectedPainting?.id === item.id && 'selected')}
              onClick={() => onSelectPainting(item)}>
              {item.files[0] && <ThumbnailImage src={FileManager.getFileUrl(item.files[0])} alt="" draggable={false} />}
              {loadingPaintingIds?.has(item.id) && <GeneratingDot />}
            </Canvas>
            <CanvasIndex title={getCanvasLabel(item)}>{getCanvasLabel(item)}</CanvasIndex>
            <DeleteButton>
              <Popconfirm
                title={t('paintings.button.delete.image.confirm')}
                onConfirm={() => onDeletePainting(item)}
                okButtonProps={{ danger: true }}
                placement="left">
                <DeleteOutlined />
              </Popconfirm>
            </DeleteButton>
          </CanvasWrapper>
        )}
      </DraggableList>
      </Container>
      {showScrollTop && !dragging && (
        <Tooltip title={t('common.navigation.top')} placement="left">
          <ScrollTopButton onClick={scrollToTop} aria-label={t('common.navigation.top')}>
            <UpOutlined />
          </ScrollTopButton>
        </Tooltip>
      )}
    </ListShell>
  )
}

const ListShell = styled.div`
  position: relative;
  flex: 1;
  width: 100px;
  min-width: 100px;
  max-width: 100px;
  height: calc(100vh - var(--navbar-height));
`

const Container = styled(Scrollbar)`
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  width: 100px;
  min-width: 100px;
  max-width: 100px;
  box-sizing: border-box;
  padding: 10px 8px;
  background-color: var(--color-background);
  border-left: 0.5px solid var(--color-border);
  height: 100%;
  overflow-x: hidden;
  scrollbar-width: auto;
  scrollbar-color: color-mix(in srgb, var(--color-scrollbar-thumb) 72%, transparent) transparent;

  &&::-webkit-scrollbar {
    width: 12px;
  }

  &&::-webkit-scrollbar-thumb {
    min-height: 48px;
    border: 3px solid var(--color-background);
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-scrollbar-thumb) 72%, transparent);

    &:hover {
      background: var(--color-scrollbar-thumb-hover);
    }
  }
`

const CanvasWrapper = styled.div`
  position: relative;
  width: 84px;
  user-select: none;
  touch-action: none;
  will-change: transform;

  &:hover {
    .delete-button {
      opacity: 1;
    }
  }
`

const Canvas = styled.div`
  width: 80px;
  height: 80px;
  margin: 0 auto;
  background-color: var(--color-background-soft);
  cursor: pointer;
  transition: background-color 0.2s ease;
  border: 1px solid var(--color-background-soft);
  overflow: hidden;
  position: relative;

  &.selected {
    border: 1px solid var(--color-primary);
  }

  &:hover {
    background-color: var(--color-background-mute);
  }
`

const ThumbnailImage = styled.img`
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
`

const GeneratingDot = styled.div`
  position: absolute;
  top: 6px;
  left: 6px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--color-primary);
  box-shadow:
    0 0 0 3px color-mix(in srgb, var(--color-primary) 18%, transparent),
    0 0 12px color-mix(in srgb, var(--color-primary) 55%, transparent);
`

const DeleteButton = styled.div.attrs({ className: 'delete-button' })`
  position: absolute;
  top: 4px;
  right: 4px;
  opacity: 0;
  transition: opacity 0.2s ease;
  border-radius: 50%;
  padding: 4px;
  cursor: pointer;
  color: var(--color-error);
  background-color: var(--color-background-soft);
  display: flex;
  align-items: center;
  justify-content: center;
`

const CanvasIndex = styled.div`
  margin-top: 6px;
  text-align: center;
  font-size: 12px;
  color: var(--color-text-2);
  max-width: 84px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const DragHint = styled.div`
  width: 84px;
  margin-top: -4px;
  text-align: center;
  font-size: 11px;
  line-height: 1.35;
  color: var(--color-text-3);
`

const NewPaintingButton = styled.div`
  width: 80px;
  height: 80px;
  min-height: 80px;
  background-color: var(--color-background-soft);
  cursor: pointer;
  transition: background-color 0.2s ease;
  border: 1px dashed var(--color-border);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-2);

  &:hover {
    background-color: var(--color-background-mute);
    border-color: var(--color-primary);
    color: var(--color-primary);
  }
`

const ScrollTopButton = styled.button`
  position: absolute;
  bottom: 12px;
  left: 50%;
  z-index: 5;
  width: 34px;
  height: 34px;
  min-height: 34px;
  border: 1px solid color-mix(in srgb, var(--color-border) 78%, transparent);
  border-radius: 50%;
  color: var(--color-text-2);
  background: color-mix(in srgb, var(--color-background) 88%, transparent);
  box-shadow: 0 8px 24px color-mix(in srgb, var(--color-black) 16%, transparent);
  cursor: pointer;
  backdrop-filter: blur(10px);
  transform: translateX(-50%);
  transition:
    color 0.2s ease,
    border-color 0.2s ease,
    background 0.2s ease,
    transform 0.2s ease;

  &:hover {
    color: var(--color-primary);
    border-color: var(--color-primary);
    background: color-mix(in srgb, var(--color-background) 96%, var(--color-primary) 4%);
    transform: translateX(-50%) translateY(-1px);
  }
`

export default PaintingsList
