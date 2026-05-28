import { CloseOutlined, LeftOutlined, RightOutlined } from '@ant-design/icons'
import ImageViewer from '@renderer/components/ImageViewer'
import FileManager from '@renderer/services/FileManager'
import type { Painting } from '@renderer/types'
import { Button, Spin } from 'antd'
import type { FC } from 'react'
import React from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface ArtboardProps {
  painting: Painting
  isLoading: boolean
  currentImageIndex: number
  onPrevImage: () => void
  onNextImage: () => void
  onCancel: () => void
  retry?: (painting: Painting) => void
  imageCover?: React.ReactNode
  loadText?: React.ReactNode
  previewUrls?: string[]
  onDeletePreview?: (index: number) => void
}

const Artboard: FC<ArtboardProps> = ({
  painting,
  isLoading,
  currentImageIndex,
  onPrevImage,
  onNextImage,
  onCancel,
  retry,
  imageCover,
  loadText,
  previewUrls = [],
  onDeletePreview
}) => {
  const { t } = useTranslation()

  const fileUrls = painting.files.map((file) => FileManager.getFileUrl(file))
  const displayUrls = fileUrls.length > 0 ? fileUrls : previewUrls
  const currentDisplayUrl = displayUrls[currentImageIndex] || ''
  const isPreviewGrid = fileUrls.length === 0 && previewUrls.length > 1
  const gridPageSize = 9
  const currentPage = Math.floor(currentImageIndex / gridPageSize)
  const totalPages = Math.max(1, Math.ceil(previewUrls.length / gridPageSize))
  const previewPageUrls = previewUrls.slice(currentPage * gridPageSize, currentPage * gridPageSize + gridPageSize)
  const gridColumnCount = previewPageUrls.length <= 1 ? 1 : previewPageUrls.length <= 4 ? 2 : 3
  const showGridPager = previewUrls.length > gridPageSize

  return (
    <Container>
      <LoadingContainer spinning={isLoading}>
        {isPreviewGrid ? (
          <CanvasFrame>
            {showGridPager && <GridNavigationButton onClick={onPrevImage} $side="left" icon={<LeftOutlined />} />}
            <PreviewGrid $columns={gridColumnCount}>
              {previewPageUrls.map((url, index) => {
                const absoluteIndex = currentPage * gridPageSize + index
                return (
                  <PreviewTile key={`${url}-${absoluteIndex}`}>
                    <ImageViewer
                      src={url}
                      preview={{ mask: false }}
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'contain',
                        cursor: 'pointer'
                      }}
                    />
                    {onDeletePreview && (
                      <DeletePreviewButton
                        size="small"
                        type="text"
                        icon={<CloseOutlined />}
                        onClick={(event) => {
                          event.stopPropagation()
                          onDeletePreview(absoluteIndex)
                        }}
                      />
                    )}
                  </PreviewTile>
                )
              })}
            </PreviewGrid>
            {showGridPager && <GridNavigationButton onClick={onNextImage} $side="right" icon={<RightOutlined />} />}
            <ImageCounter>
              {currentPage + 1} / {totalPages}
            </ImageCounter>
          </CanvasFrame>
        ) : displayUrls.length > 0 ? (
          <CanvasFrame>
            {displayUrls.length > 1 && (
              <NavigationButton onClick={onPrevImage} style={{ left: 10 }}>
                {'<'}
              </NavigationButton>
            )}
            <ImageViewer
              src={currentDisplayUrl}
              preview={{ mask: false }}
              style={{
                maxWidth: 'var(--artboard-max)',
                maxHeight: 'var(--artboard-max)',
                objectFit: 'contain',
                backgroundColor: 'var(--color-background-soft)',
                cursor: 'pointer'
              }}
            />
            {displayUrls.length > 1 && (
              <NavigationButton onClick={onNextImage} style={{ right: 10 }}>
                {'>'}
              </NavigationButton>
            )}
            <ImageCounter>
              {currentImageIndex + 1} / {displayUrls.length}
            </ImageCounter>
          </CanvasFrame>
        ) : (
          <ImagePlaceholder>
            {painting.urls.length > 0 && retry ? (
              <div>
                <ImageList>
                  {painting.urls.map((url, index) => (
                    <ImageListItem key={url || index}>{url}</ImageListItem>
                  ))}
                </ImageList>
                <div>
                  {t('paintings.proxy_required')}
                  <Button type="link" onClick={() => retry?.(painting)}>
                    {t('paintings.image_retry')}
                  </Button>
                </div>
              </div>
            ) : imageCover ? (
              imageCover
            ) : loadText && isLoading ? (
              ''
            ) : (
              <div>{t('paintings.image_placeholder')}</div>
            )}
          </ImagePlaceholder>
        )}
        {isLoading && (
          <LoadingOverlay>
            <LoadingStatus>
              <Spin size="large" />
              {loadText || ''}
            </LoadingStatus>
            <CancelButton danger type="primary" size="large" onClick={onCancel}>
              {t('common.cancel')}
            </CancelButton>
          </LoadingOverlay>
        )}
      </LoadingContainer>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex: 1;
  flex-direction: row;
  justify-content: center;
  align-items: center;
  padding: 24px;
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--color-border) 34%, transparent) 1px, transparent 1px),
    linear-gradient(0deg, color-mix(in srgb, var(--color-border) 34%, transparent) 1px, transparent 1px);
  background-size: 24px 24px;

  --artboard-max: min(calc(100vh - 280px), calc(100vw - 520px));
`

const ImagePlaceholder = styled.div`
  display: flex;
  width: var(--artboard-max);
  height: var(--artboard-max);
  min-width: 320px;
  min-height: 320px;
  background-color: var(--color-background);
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
  border: 1px solid var(--color-border);
  box-shadow:
    0 18px 44px rgba(15, 23, 42, 0.08),
    0 1px 0 rgba(255, 255, 255, 0.6) inset;
`

const ImageList = styled.ul`
  list-style: none;
  padding: 0;
  margin: 0;
  word-break: break-all;
  user-select: text;
`

const ImageListItem = styled.li`
  color: var(--color-text-secondary);
  margin-bottom: 10px;
`

const CanvasFrame = styled.div`
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 320px;
  min-height: 320px;
  padding: 18px;
  background: var(--color-background);
  border: 1px solid var(--color-border);
  box-shadow:
    0 18px 44px rgba(15, 23, 42, 0.08),
    0 1px 0 rgba(255, 255, 255, 0.6) inset;

  .ant-spin {
    max-height: none;
  }

  .ant-spin-spinning {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 3;
  }
`

const PreviewGrid = styled.div<{ $columns: number }>`
  display: grid;
  grid-template-columns: repeat(${(props) => props.$columns}, minmax(0, 1fr));
  gap: 10px;
  width: min(var(--artboard-max), 680px);
  height: min(var(--artboard-max), 680px);
  padding: 4px;
`

const PreviewTile = styled.div`
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background:
    linear-gradient(45deg, color-mix(in srgb, var(--color-border) 24%, transparent) 25%, transparent 25%),
    linear-gradient(-45deg, color-mix(in srgb, var(--color-border) 24%, transparent) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, color-mix(in srgb, var(--color-border) 24%, transparent) 75%),
    linear-gradient(-45deg, transparent 75%, color-mix(in srgb, var(--color-border) 24%, transparent) 75%),
    var(--color-background-soft);
  background-position:
    0 0,
    0 8px,
    8px -8px,
    -8px 0;
  background-size: 16px 16px;
  border: 1px solid var(--color-border-soft);
  aspect-ratio: 1;

  .ant-image {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .ant-image-img {
    width: auto;
    height: auto;
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    display: block;
  }
`

const DeletePreviewButton = styled(Button)`
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 2;
  width: 22px;
  height: 22px;
  min-width: 22px;
  padding: 0;
  color: #fff;
  background: rgba(0, 0, 0, 0.55);
  border-radius: 50%;

  &:hover {
    color: #fff !important;
    background: rgba(0, 0, 0, 0.72) !important;
  }
`

const NavigationButton = styled(Button)`
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 2;
  opacity: 0.7;

  &:hover {
    opacity: 1;
  }
`

const GridNavigationButton = styled(Button)<{ $side: 'left' | 'right' }>`
  position: absolute;
  top: 50%;
  ${(props) => props.$side}: -30px;
  transform: translateY(-50%);
  z-index: 4;
  width: 46px;
  height: 64px;
  min-width: 46px;
  padding: 0;
  color: color-mix(in srgb, var(--color-text) 86%, #1d4ed8);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(246, 249, 255, 0.9)) !important;
  border: 1px solid color-mix(in srgb, var(--color-border) 70%, #3b82f6);
  border-radius: 999px;
  box-shadow:
    0 14px 32px rgba(15, 23, 42, 0.18),
    0 1px 0 rgba(255, 255, 255, 0.86) inset;
  font-size: 20px;
  backdrop-filter: blur(10px);
  transition:
    transform 0.18s ease,
    box-shadow 0.18s ease,
    color 0.18s ease,
    border-color 0.18s ease;

  .anticon {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  &:hover,
  &:focus-visible {
    color: #2563eb !important;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 1), rgba(239, 246, 255, 0.96)) !important;
    border-color: rgba(37, 99, 235, 0.46) !important;
    transform: translateY(-50%) scale(1.04);
    box-shadow:
      0 18px 38px rgba(37, 99, 235, 0.22),
      0 0 0 4px rgba(37, 99, 235, 0.1);
  }
`

const ImageCounter = styled.div`
  position: absolute;
  bottom: 10px;
  left: 50%;
  transform: translateX(-50%);
  background-color: rgba(0, 0, 0, 0.5);
  color: white;
  padding: 4px 8px;
  border-radius: 12px;
  font-size: 12px;
`

const LoadingContainer = styled.div<{ spinning: boolean }>`
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  transition: opacity 0.3s;

  > :not(.loading-overlay) {
    opacity: ${(props) => (props.spinning ? 0.42 : 1)};
    transition: opacity 0.3s;
  }
`

const LoadingOverlay = styled.div.attrs({ className: 'loading-overlay' })`
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
`

const LoadingStatus = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  color: var(--color-text-2);
  pointer-events: none;
`

const CancelButton = styled(Button)`
  position: absolute;
  left: 50%;
  bottom: max(26px, calc((100% - var(--artboard-max)) / 2 + 26px));
  transform: translateX(-50%);
  z-index: 21;
  min-width: 118px;
  height: 42px;
  padding: 0 26px;
  border-radius: 999px;
  font-size: 15px;
  font-weight: 600;
  box-shadow:
    0 14px 34px rgba(220, 38, 38, 0.28),
    0 0 0 5px color-mix(in srgb, var(--color-background) 84%, transparent);
  pointer-events: auto;

  &:hover,
  &:focus-visible {
    transform: translateX(-50%) translateY(-1px);
    box-shadow:
      0 18px 42px rgba(220, 38, 38, 0.34),
      0 0 0 5px color-mix(in srgb, var(--color-background) 84%, transparent);
  }
`

export default Artboard
