import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import PaintingsList from '../PaintingsList'

vi.mock('@renderer/hooks/usePaintings', () => ({
  usePaintings: () => ({
    updatePaintings: vi.fn()
  })
}))

vi.mock('@renderer/components/DraggableList', () => ({
  DraggableList: ({ list, children }: any) => <div>{list.map((item: any) => children(item))}</div>
}))

vi.mock('@renderer/services/FileManager', () => ({
  default: {
    getFileUrl: (file: any) => `file://${file.name}`
  }
}))

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn()
  },
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'paintings.button.delete.image.confirm': 'Delete image?',
        'paintings.source': '来源',
        'paintings.source_deleted': '来源已删'
      }
      return translations[key] || key
    }
  })
}))

function imageFile(id: string) {
  return {
    id,
    name: `${id}.png`,
    origin_name: `${id}.png`,
    path: `${id}.png`,
    size: 100,
    ext: '.png',
    type: 'image',
    count: 1,
    created_at: '2026-06-01T00:00:00.000Z'
  } as any
}

function renderList(paintings: any[]) {
  return render(
    <PaintingsList
      namespace="openai_image_generate"
      paintings={paintings}
      selectedPainting={null}
      onSelectPainting={vi.fn()}
      onDeletePainting={vi.fn()}
      onNewPainting={vi.fn()}
    />
  )
}

describe('PaintingsList source labels', () => {
  it('shows only the current index when there is no source image', () => {
    renderList([{ id: 'painting-1', files: [imageFile('image-1')], urls: [] }])

    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('shows the source painting index for derived images', () => {
    renderList([
      {
        id: 'derived',
        files: [imageFile('derived')],
        urls: [],
        sourcePaintingId: 'source',
        sourceImageIndex: 0,
        sourceImageCount: 1
      },
      { id: 'source', files: [imageFile('source')], urls: [] }
    ])

    expect(screen.getByText('2--来源1')).toBeInTheDocument()
  })

  it('shows source image index when the source painting has multiple images', () => {
    renderList([
      {
        id: 'derived',
        files: [imageFile('derived')],
        urls: [],
        sourcePaintingId: 'source',
        sourceImageIndex: 1,
        sourceImageCount: 3
      },
      { id: 'source', files: [imageFile('source-1'), imageFile('source-2'), imageFile('source-3')], urls: [] }
    ])

    expect(screen.getByText('2--来源1-2')).toBeInTheDocument()
  })

  it('shows deleted source text when the source painting is missing', () => {
    renderList([
      {
        id: 'derived',
        files: [imageFile('derived')],
        urls: [],
        sourcePaintingId: 'missing-source',
        sourceImageIndex: 0,
        sourceImageCount: 1
      }
    ])

    expect(screen.getByText('1--来源已删')).toBeInTheDocument()
  })
})
