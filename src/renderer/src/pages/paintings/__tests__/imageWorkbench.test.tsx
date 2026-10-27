import '../../../../../../packages/image-workbench/src/i18n'

import type { ImageCanvasTask } from '@shared/config/imageCanvas'
import { defaultImageCapabilities } from '@shared/config/imageCapabilities'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import i18next from 'i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as DraftModule from '../../../../../../packages/image-workbench/src/draft'
import { emptyDraft } from '../../../../../../packages/image-workbench/src/draft'
import Workbench from '../../../../../../packages/image-workbench/src/Workbench'

vi.mock('../../../../../../packages/image-workbench/src/draft', async () => {
  const original = await vi.importActual<typeof DraftModule>('../../../../../../packages/image-workbench/src/draft')
  return {
    ...original,
    readDraft: vi.fn(async () => ({ ...original.emptyDraft })),
    writeDraft: vi.fn(async () => undefined)
  }
})

const model = { id: 'gpt-image-2', name: 'Image model', protocol: 'openai' as const }
const catalog = [
  { id: 'a', name: 'Gateway A', models: [{ ...model, capabilities: defaultImageCapabilities(model) }] },
  {
    id: 'b',
    name: 'Gateway B',
    models: [{ ...model, capabilities: { ...defaultImageCapabilities(model), maxReferences: 0 } }]
  }
]
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

beforeEach(async () => {
  await i18next.changeLanguage('en')
  window.imageCanvas = {
    catalog: vi.fn(async () => structuredClone(catalog)),
    history: vi.fn(async () => []),
    submit: vi.fn(),
    task: vi.fn(),
    asset: vi.fn(),
    recover: vi.fn(),
    configure: vi.fn(),
    remove: vi.fn(),
    exportAsset: vi.fn(),
    flush: vi.fn(() => () => undefined)
  }
})
afterEach(() => {
  cleanup()
  delete window.imageCanvas
  vi.restoreAllMocks()
})

describe('image workbench workflows', () => {
  it('shows upload failures as not submitted with safe request evidence, not a billing warning', async () => {
    const task: ImageCanvasTask = {
      id: 'preparation-failed',
      providerId: 'a',
      modelId: model.id,
      prompt: 'edit the poster',
      createdAt: new Date().toISOString(),
      status: 'failed',
      assets: [],
      recoverable: false,
      error: 'studio_reference_upload_failed',
      diagnostics: {
        protocol: 'openai',
        capabilitySource: 'server',
        capabilityRevision: 'previous',
        attempts: 1,
        transport: 'studio',
        generationSubmitted: false,
        failedPhase: 'uploading',
        phaseDurationsMs: { uploading: 241000 },
        requestFailure: {
          operation: 'reference-upload',
          endpoint: '/api/image-studio/assets',
          method: 'POST',
          reason: 'timeout',
          errorName: 'TimeoutError',
          durationMs: 120000,
          timeoutMs: 120000,
          attempt: 2
        }
      }
    }
    vi.mocked(window.imageCanvas!.history).mockResolvedValue([task])
    render(<Workbench />)
    await screen.findByText(/No generation task was submitted and the image model has not been called/)
    expect(screen.getByText('Stopped during: Uploading references')).toBeInTheDocument()
    expect(screen.getByText('POST /api/image-studio/assets')).toBeInTheDocument()
    expect(screen.getByText(/Request timed out · TimeoutError/)).toBeInTheDocument()
    expect(screen.getByText('120.0 s / 120.0 s timeout · attempt 2')).toBeInTheDocument()
    expect(screen.queryByText(/may have accepted/)).not.toBeInTheDocument()
    expect(screen.queryByText(/direct endpoint/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retrieve original result' })).not.toBeInTheDocument()
    expect(window.imageCanvas!.submit).not.toHaveBeenCalled()
  })
  it('does not infer a direct endpoint from a legacy server task without recovery metadata', async () => {
    vi.mocked(window.imageCanvas!.history).mockResolvedValue([
      {
        id: 'legacy-uncertain',
        providerId: 'a',
        modelId: model.id,
        prompt: 'legacy task',
        createdAt: new Date().toISOString(),
        status: 'uncertain',
        assets: [],
        recoverable: false,
        diagnostics: {
          protocol: 'openai',
          capabilitySource: 'server',
          capabilityRevision: 'previous',
          attempts: 1,
          phaseDurationsMs: { preparing: 30000 },
          failedPhase: 'preparing'
        }
      }
    ])
    render(<Workbench />)
    await screen.findByRole('heading', { name: 'Result unconfirmed' })
    expect(screen.queryByText(/direct endpoint/i)).not.toBeInTheDocument()
    expect(window.imageCanvas!.submit).not.toHaveBeenCalled()
  })
  it('combines ratios and resolutions in one size selector and submits the selected 4K preference', async () => {
    const gemini = { id: 'gemini-2.5-flash-image', name: 'Gemini image', protocol: 'gemini' as const }
    vi.mocked(window.imageCanvas!.catalog).mockResolvedValue([
      {
        id: 'a',
        name: 'Zen',
        models: [{ ...gemini, capabilities: { ...defaultImageCapabilities(gemini), source: 'server' } }]
      }
    ])
    vi.mocked(window.imageCanvas!.submit).mockImplementation(async (input) => ({
      id: input.id,
      providerId: input.providerId,
      modelId: input.modelId,
      prompt: input.prompt,
      createdAt: new Date().toISOString(),
      status: 'running',
      assets: []
    }))
    render(<Workbench />)
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue(gemini.id))
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'a landscape' } })
    expect(screen.queryByLabelText('Aspect ratio')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Resolution / size')).not.toBeInTheDocument()
    const resolution = screen.getByLabelText('Image size')
    expect(resolution).toHaveValue(JSON.stringify(['auto', 'auto', '']))
    expect(resolution.querySelector('option')).toHaveTextContent('Auto (smart match)')
    expect(resolution).toHaveTextContent('1K')
    expect(resolution).toHaveTextContent('2K')
    expect(resolution).toHaveTextContent('4K')
    fireEvent.change(resolution, { target: { value: JSON.stringify(['16:9', '16:9', '4K']) } })
    fireEvent.click(screen.getByRole('button', { name: /Generate image/ }))
    await waitFor(() =>
      expect(window.imageCanvas!.submit).toHaveBeenCalledWith(
        expect.objectContaining({ size: '16:9', aspectRatio: '16:9', resolution: '4K' })
      )
    )
  })
  it('shows expanded settings by default and puts model comparison last', async () => {
    const { container } = render(<Workbench />)
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue(model.id))
    expect(screen.queryByRole('button', { name: /More settings/ })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Quality')).toBeVisible()
    expect(screen.getByLabelText('Background')).toBeVisible()
    expect(screen.getByLabelText('Images')).toBeVisible()
    const settings = screen.getByRole('region', { name: 'More settings' })
    expect(settings.lastElementChild).toBe(screen.getByRole('region', { name: 'Compare models' }))
    expect(screen.getByLabelText('Gateway B · Image model')).toBeVisible()
    expect(container.querySelector('#image-advanced details')).not.toBeInTheDocument()
  })
  it('puts automatic sizing first even when the model catalog lists it last', async () => {
    const reordered = structuredClone(catalog)
    reordered[0].models[0].capabilities.dimensions = [
      { ratio: '2:3', size: '1024x1536' },
      { ratio: '1:1', size: '1024x1024' },
      { ratio: 'auto', size: 'auto' }
    ]
    vi.mocked(window.imageCanvas!.catalog).mockResolvedValue(reordered)
    render(<Workbench />)
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue(model.id))
    const size = screen.getByLabelText('Image size')
    expect(size).toHaveValue(JSON.stringify(['auto', 'auto', '']))
    expect(size.querySelector('option')).toHaveTextContent('Auto (smart match)')
    expect(size).toHaveTextContent('Portrait 1024 × 1536')
    expect(size).toHaveTextContent('Square 1024 × 1024')
  })
  it('shows understandable Chinese size labels without changing the saved selection', async () => {
    const { readDraft } = await import('../../../../../../packages/image-workbench/src/draft')
    vi.mocked(readDraft).mockResolvedValueOnce({
      ...emptyDraft,
      providerId: 'a',
      modelId: model.id,
      dimension: JSON.stringify(['2:3', '1024x1536', ''])
    })
    await i18next.changeLanguage('zh')
    render(<Workbench />)
    await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue(model.id))
    const size = await screen.findByLabelText('图片尺寸')
    expect(size).toHaveValue(JSON.stringify(['2:3', '1024x1536', '']))
    expect(size.querySelector('option')).toHaveTextContent('自动（智能匹配）')
    expect(size).toHaveTextContent('竖图 1024 × 1536')
    expect(size).toHaveTextContent('横图 1536 × 1024')
    expect(size).toHaveTextContent('方图 1024 × 1024')
  })
  it('starts a blank draft without restoring old results on polling or removing history', async () => {
    const { readDraft, writeDraft } = await import('../../../../../../packages/image-workbench/src/draft')
    const reference = 'data:image/png;base64,iVBORw0KGgo='
    vi.mocked(readDraft).mockResolvedValueOnce({
      ...emptyDraft,
      providerId: 'a',
      modelId: model.id,
      prompt: 'old edit',
      dimension: JSON.stringify(['auto', 'auto', '']),
      quality: 'high',
      count: 3,
      references: [reference],
      mask: reference,
      expansion: { top: 64, right: 0, bottom: 0, left: 0 },
      comparisons: [{ providerId: 'b', modelId: model.id }]
    })
    const record: ImageCanvasTask = {
      id: 'previous-image',
      providerId: 'a',
      modelId: model.id,
      prompt: 'previous landscape',
      createdAt: new Date().toISOString(),
      status: 'completed',
      assets: ['result']
    }
    vi.mocked(window.imageCanvas!.history).mockResolvedValue([record])
    vi.mocked(window.imageCanvas!.asset).mockResolvedValue(reference)
    const interval = vi.spyOn(globalThis, 'setInterval')
    const { container } = render(<Workbench />)
    await screen.findByAltText(record.prompt)
    await waitFor(() => expect(screen.getByLabelText('Provider')).toHaveValue('a'))
    expect(container.querySelectorAll('.reference img')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /New image/ }))
    expect(screen.getByLabelText('Prompt')).toHaveValue('')
    expect(screen.getByLabelText('Prompt')).toHaveFocus()
    expect(screen.getByLabelText('Provider')).toHaveValue('a')
    expect(screen.getByLabelText('Model')).toHaveValue(model.id)
    expect(screen.queryByAltText(record.prompt)).not.toBeInTheDocument()
    expect(container.querySelectorAll('.reference img')).toHaveLength(0)
    expect(screen.getByRole('heading', { name: 'Turn an idea into an image' })).toBeInTheDocument()
    const poll = interval.mock.calls.find((call) => call[1] === 2000)![0] as () => void
    await act(async () => {
      poll()
      await Promise.resolve()
    })
    expect(screen.queryByAltText(record.prompt)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Recent images/ }))
    expect(screen.getByText(record.prompt)).toBeInTheDocument()
    expect(window.imageCanvas!.remove).not.toHaveBeenCalled()
    expect(window.imageCanvas!.submit).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(writeDraft).toHaveBeenLastCalledWith(
        expect.objectContaining({
          providerId: 'a',
          modelId: model.id,
          quality: 'high',
          count: 3,
          prompt: '',
          references: [],
          mask: undefined,
          expansion: undefined,
          comparisons: []
        })
      )
    )
  })
  it('ignores a late reference load from reuse after starting a new image', async () => {
    const record: ImageCanvasTask = {
      id: 'previous-edit',
      providerId: 'a',
      modelId: model.id,
      prompt: 'old prompt',
      createdAt: new Date().toISOString(),
      status: 'completed',
      assets: [],
      referenceAssets: ['slow-reference']
    }
    vi.mocked(window.imageCanvas!.history).mockResolvedValue([record])
    let finishRead!: (value: string) => void
    vi.mocked(window.imageCanvas!.asset).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRead = resolve
        })
    )
    render(<Workbench />)
    await waitFor(() => expect(screen.getByLabelText('Provider')).toHaveValue('a'))
    fireEvent.click(await screen.findByRole('button', { name: 'Reuse parameters' }))
    fireEvent.click(screen.getByRole('button', { name: /New image/ }))
    await act(async () => {
      finishRead('data:image/png;base64,iVBORw0KGgo=')
    })
    expect(screen.getByLabelText('Prompt')).toHaveValue('')
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByText('Text to image')).toBeInTheDocument()
    expect(window.imageCanvas!.submit).not.toHaveBeenCalled()
  })
  it('loads older history through a cursor beyond the first page', async () => {
    const record = (id: string): ImageCanvasTask => ({
      id,
      providerId: 'a',
      modelId: model.id,
      prompt: id,
      createdAt: new Date().toISOString(),
      status: 'completed',
      assets: []
    })
    window.imageCanvas!.historyPage = vi.fn(async (cursor) =>
      cursor
        ? { items: [record('older record')], total: 151 }
        : { items: [record('latest record')], total: 151, nextCursor: 'older-cursor' }
    )
    render(<Workbench />)
    await waitFor(() => expect(window.imageCanvas!.historyPage).toHaveBeenCalledWith(undefined, 30))
    fireEvent.click(screen.getByRole('button', { name: /Recent images/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Load more records' }))
    await screen.findByText('older record')
    expect(window.imageCanvas!.historyPage).toHaveBeenCalledWith('older-cursor', 30)
    expect(window.imageCanvas!.history).not.toHaveBeenCalled()
  })
  it('explains separate billing and submits comparison targets as one durable batch', async () => {
    window.imageCanvas!.submitBatch = vi.fn(async (inputs) =>
      inputs.map((input) => ({ ...input, createdAt: new Date().toISOString(), status: 'running', assets: [] }))
    )
    render(<Workbench />)
    await waitFor(() => expect(screen.getByLabelText('Provider')).toHaveValue('a'))
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'compare a waterfall' } })
    fireEvent.click(screen.getByLabelText('Gateway B · Image model'))
    expect(
      screen.getByText('2 separate model tasks will be submitted and may be billed separately.')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Generate with 2 models/ }))
    await waitFor(() => expect(window.imageCanvas!.submitBatch).toHaveBeenCalledOnce())
    const inputs = vi.mocked(window.imageCanvas!.submitBatch).mock.calls[0][0]
    expect(inputs.map((input) => input.providerId)).toEqual(['a', 'b'])
    expect(inputs[0].batchId).toBe(inputs[1].batchId)
    expect(inputs[0].id).not.toBe(inputs[1].id)
    expect(window.imageCanvas!.submit).not.toHaveBeenCalled()
  })
  it('blocks every comparison task if one selected model rejects the reference images', async () => {
    const { readDraft } = await import('../../../../../../packages/image-workbench/src/draft')
    vi.mocked(readDraft).mockResolvedValueOnce({
      ...emptyDraft,
      providerId: 'a',
      modelId: model.id,
      prompt: 'edit',
      dimension: JSON.stringify(['auto', 'auto', '']),
      references: ['data:image/png;base64,iVBORw0KGgo='],
      comparisons: [{ providerId: 'b', modelId: model.id }]
    })
    window.imageCanvas!.submitBatch = vi.fn()
    render(<Workbench />)
    await waitFor(() => expect(screen.getByLabelText('Provider')).toHaveValue('a'))
    expect(screen.getByRole('button', { name: /Generate with 2 models/ })).toBeDisabled()
    expect(window.imageCanvas!.submitBatch).not.toHaveBeenCalled()
    expect(window.imageCanvas!.submit).not.toHaveBeenCalled()
  })
  it('shows a generated image awaiting download and retrieves it without submitting generation', async () => {
    const task: ImageCanvasTask = {
      id: 'saved-job',
      providerId: 'a',
      modelId: model.id,
      prompt: 'a waterfall',
      createdAt: new Date().toISOString(),
      status: 'uncertain',
      assets: [],
      error: 'studio_download_failed',
      recoverable: true,
      diagnostics: {
        protocol: 'openai',
        capabilitySource: 'server',
        capabilityRevision: 'abc123',
        attempts: 1,
        phaseDurationsMs: { generating: 125000, downloading: 60000 },
        failedPhase: 'downloading',
        server: {
          jobId: 'server-task-id',
          phaseDurationsMs: { queued: 1200, relay: 245000, archiving: 5000 },
          httpStatus: 200
        }
      }
    }
    vi.mocked(window.imageCanvas!.history).mockResolvedValue([task])
    vi.mocked(window.imageCanvas!.recover).mockResolvedValue({ ...task, status: 'running', error: undefined })
    render(<Workbench />)
    await screen.findByRole('heading', { name: 'Image download pending' })
    expect(
      screen.getByText('Generated, but not downloaded yet. Retrieve the original result without generating again.')
    ).toBeInTheDocument()
    expect(screen.getByText('Stopped during: Downloading images')).toBeInTheDocument()
    expect(screen.getByText('Task diagnostics', { exact: false })).toHaveTextContent('185.0 s')
    expect(screen.getByText('server-task-id')).toBeInTheDocument()
    expect(screen.getByText('245.0 s')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retrieve original result' }))
    await waitFor(() => expect(window.imageCanvas!.recover).toHaveBeenCalledWith(task.id))
    expect(window.imageCanvas!.submit).not.toHaveBeenCalled()
  })
  it('does not submit a shortcut during IME composition or while references are being read', async () => {
    vi.mocked(window.imageCanvas!.submit).mockImplementation(async (input) => ({
      id: input.id,
      providerId: input.providerId,
      modelId: input.modelId,
      prompt: input.prompt,
      createdAt: new Date().toISOString(),
      status: 'running',
      assets: []
    }))
    const images = await import('../../../../../../packages/image-workbench/src/browserImages')
    let finishRead: (value: string) => void = () => undefined
    vi.spyOn(images, 'blobToDataUrl').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRead = resolve
        })
    )
    render(<Workbench />)
    await waitFor(() => expect(screen.getByLabelText('Provider')).toHaveValue('a'))
    const area = screen.getByLabelText('Prompt')
    fireEvent.change(area, { target: { value: 'edit this image' } })
    fireEvent.keyDown(area, { key: 'Enter', ctrlKey: true, isComposing: true })
    expect(window.imageCanvas!.submit).not.toHaveBeenCalled()
    const input = document.querySelector('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File([png], 'reference.png', { type: 'image/png' })] } })
    await screen.findByText('Reading reference images…')
    expect(screen.getByRole('button', { name: /Generate image/ })).toBeDisabled()
    fireEvent.keyDown(area, { key: 'Enter', ctrlKey: true })
    expect(window.imageCanvas!.submit).not.toHaveBeenCalled()
    finishRead('data:image/png;base64,iVBORw0KGgo=')
    await waitFor(() => expect(screen.queryByText('Reading reference images…')).not.toBeInTheDocument())
    fireEvent.keyDown(area, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(window.imageCanvas!.submit).toHaveBeenCalledOnce())
    expect(vi.mocked(window.imageCanvas!.submit).mock.calls[0][0].references).toHaveLength(1)
  })
  it('uses the configured provider instance and submits only once on rapid clicks', async () => {
    let accept: ((value: any) => void) | undefined
    vi.mocked(window.imageCanvas!.submit).mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = resolve
        })
    )
    render(<Workbench />)
    await waitFor(() => expect(screen.getByLabelText('Provider')).toHaveValue('a'))
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'b' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'a house' } })
    const button = screen.getByRole('button', { name: /Generate image/ })
    await waitFor(() => expect(button).not.toBeDisabled())
    fireEvent.click(button)
    fireEvent.click(button)
    expect(window.imageCanvas!.submit).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(window.imageCanvas!.submit).mock.calls[0][0]
    expect(payload).toMatchObject({ providerId: 'b', modelId: model.id, prompt: 'a house', count: 1, references: [] })
    accept!({ ...payload, status: 'running', createdAt: new Date().toISOString(), assets: [] })
    await screen.findByText('You can leave this page; tasks continue while the app is running.')
    expect(screen.getByRole('button', { name: /Generate image/ })).toBeDisabled()
  })
  it('retains multiple references on a switch to an incompatible provider and blocks submission', async () => {
    const { container } = render(<Workbench />)
    await waitFor(() => expect(screen.getByLabelText('Provider')).toHaveValue('a'))
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'combine these' } })
    fireEvent.change(container.querySelector('input[type=file]')!, {
      target: {
        files: [new File([png], 'a.png', { type: 'image/png' }), new File([png], 'b.png', { type: 'image/png' })]
      }
    })
    await waitFor(() => expect(container.querySelectorAll('.reference img')).toHaveLength(2))
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'b' } })
    expect(container.querySelectorAll('.reference img')).toHaveLength(2)
    expect(screen.getByRole('button', { name: /Generate image/ })).toBeDisabled()
    expect(window.imageCanvas!.submit).not.toHaveBeenCalled()
  })
  it('keeps an invalid restored dimension unselected instead of silently substituting a new ratio', async () => {
    const { readDraft } = await import('../../../../../../packages/image-workbench/src/draft')
    vi.mocked(readDraft).mockResolvedValueOnce({
      ...emptyDraft,
      providerId: 'a',
      modelId: model.id,
      prompt: 'test',
      dimension: JSON.stringify(['16:9', '1536x1024', ''])
    })
    render(<Workbench />)
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue(model.id))
    expect(await screen.findByLabelText('Image size')).toHaveValue('')
    expect(screen.getByRole('button', { name: /Generate image/ })).toBeDisabled()
    expect(window.imageCanvas!.submit).not.toHaveBeenCalled()
  })
  it('retains unsupported settings on a provider switch and allows explicit correction before generating', async () => {
    const restricted = structuredClone(catalog)
    restricted[1].models[0].capabilities = {
      ...restricted[1].models[0].capabilities,
      dimensions: [{ ratio: '1:1', size: '1024x1024' }],
      qualities: [],
      backgrounds: [],
      maxImages: 1
    }
    vi.mocked(window.imageCanvas!.catalog).mockResolvedValue(restricted)
    render(<Workbench />)
    await waitFor(() => expect(screen.getByLabelText('Provider')).toHaveValue('a'))
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'a wide landscape' } })
    fireEvent.change(screen.getByLabelText('Image size'), {
      target: { value: JSON.stringify(['3:2', '1536x1024', '']) }
    })
    fireEvent.change(screen.getByLabelText('Quality'), { target: { value: 'high' } })
    fireEvent.change(screen.getByLabelText('Background'), { target: { value: 'transparent' } })
    fireEvent.change(screen.getByLabelText('Images'), { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'b' } })
    expect(screen.getByLabelText('Image size')).toHaveValue('')
    expect(screen.getByLabelText('Quality')).toHaveValue('high')
    expect(screen.getByLabelText('Background')).toHaveValue('transparent')
    expect(screen.getByLabelText('Images')).toHaveValue('4')
    expect(screen.getByRole('button', { name: /Generate image/ })).toBeDisabled()
    expect(window.imageCanvas!.submit).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Image size'), {
      target: { value: JSON.stringify(['1:1', '1024x1024', '']) }
    })
    fireEvent.change(screen.getByLabelText('Quality'), { target: { value: 'auto' } })
    fireEvent.change(screen.getByLabelText('Background'), { target: { value: 'auto' } })
    fireEvent.change(screen.getByLabelText('Images'), { target: { value: '1' } })
    expect(screen.getByRole('button', { name: /Generate image/ })).not.toBeDisabled()
  })
})
