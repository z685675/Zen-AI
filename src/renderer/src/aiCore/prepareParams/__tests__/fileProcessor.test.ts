import type { FileMetadata, Model, Provider } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import type { FileMessageBlock } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getProviderByModel: vi.fn(),
  getAiSdkProviderId: vi.fn(),
  supportsNativePdfInput: vi.fn(),
  getFileSizeLimit: vi.fn(() => 20 * 1024 * 1024),
  supportsLargeFileUpload: vi.fn(() => false)
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getDefaultAssistant: vi.fn(() => ({ id: 'default', name: 'Default', topics: [] })),
  getProviderByModel: mocks.getProviderByModel
}))

vi.mock('../../provider/factory', () => ({
  getAiSdkProviderId: mocks.getAiSdkProviderId
}))

vi.mock('../modelCapabilities', () => ({
  getFileSizeLimit: mocks.getFileSizeLimit,
  supportsImageInput: vi.fn(() => false),
  supportsLargeFileUpload: mocks.supportsLargeFileUpload
}))

vi.mock('../pdfCapabilities', () => ({
  supportsNativePdfInput: mocks.supportsNativePdfInput
}))

import { convertFileBlockToFilePart, convertFileBlockToTextPart } from '../fileProcessor'

const model = { id: 'gpt-5.6-luna', name: 'gpt-5.6-luna', provider: 'custom' } as Model
const provider = {
  id: 'custom',
  name: 'Custom',
  type: 'openai',
  apiKey: 'test',
  apiHost: 'https://example.com',
  models: []
} as Provider
const pdfFile = {
  id: 'pdf-id',
  name: 'pdf-id.pdf',
  origin_name: 'report.pdf',
  ext: '.pdf',
  type: FILE_TYPE.DOCUMENT,
  size: 930_157
} as FileMetadata
const pdfBlock = { file: pdfFile } as FileMessageBlock

describe('fileProcessor PDF routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getProviderByModel.mockReturnValue(provider)
    mocks.getAiSdkProviderId.mockReturnValue('custom')
    Object.assign(window.api.file, {
      base64File: vi.fn().mockResolvedValue({ data: 'raw-pdf-base64', mime: 'application/pdf' }),
      read: vi.fn(),
      readStructured: vi.fn()
    })
  })

  it('extracts text before context planning for compatible providers', async () => {
    mocks.supportsNativePdfInput.mockReturnValue(false)

    await expect(convertFileBlockToFilePart(pdfBlock, model)).resolves.toBeNull()
    expect(window.api.file.base64File).not.toHaveBeenCalled()
  })

  it('keeps native PDF input for confirmed native protocols', async () => {
    mocks.supportsNativePdfInput.mockReturnValue(true)

    await expect(convertFileBlockToFilePart(pdfBlock, model)).resolves.toEqual({
      type: 'file',
      data: 'raw-pdf-base64',
      mediaType: 'application/pdf',
      filename: 'report.pdf'
    })
    expect(window.api.file.base64File).toHaveBeenCalledWith('pdf-id.pdf')
  })

  it('preserves PDF page locators in extracted text', async () => {
    vi.mocked(window.api.file.readStructured).mockResolvedValue({
      parserVersion: 1,
      format: 'pdf',
      sections: [
        { text: 'First page', metadata: { page: 1 } },
        { text: 'Second page', metadata: { page: 2 } }
      ]
    })

    await expect(convertFileBlockToTextPart(pdfBlock)).resolves.toEqual({
      type: 'text',
      text: 'report.pdf\n[page 1]\nFirst page\n\n[page 2]\nSecond page'
    })
  })
})
