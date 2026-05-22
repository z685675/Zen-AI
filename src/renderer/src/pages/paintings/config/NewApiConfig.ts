import type { GeneratePainting } from '@renderer/types'
import { uuid } from '@renderer/utils'

type PaintingOption<Value extends string = string> = {
  value: Value
  label?: string
  descriptionKey?: string
  isExperimental?: boolean
}

export type PaintingModelConfig = {
  name: string
  group: string
  imageSizes: PaintingOption[]
  max_images: number
  quality: PaintingOption[]
  moderation: PaintingOption[]
  output_compression_format: PaintingOption[]
  output_format: PaintingOption[]
  background: PaintingOption[]
}

const GPT_IMAGE_1_SIZES: PaintingOption[] = [
  { value: 'auto' },
  { value: '1024x1024', label: 'paintings.image_size_options.1024x1024' },
  { value: '1536x1024', label: 'paintings.image_size_options.1536x1024' },
  { value: '1024x1536', label: 'paintings.image_size_options.1024x1536' }
]

const GPT_IMAGE_2_SIZES: PaintingOption[] = [
  { value: 'auto' },
  { value: '1024x1024', label: 'paintings.image_size_options.1024x1024' },
  { value: '1536x1024', label: 'paintings.image_size_options.1536x1024' },
  { value: '1024x1536', label: 'paintings.image_size_options.1024x1536' },
  { value: '2048x2048', label: 'paintings.image_size_options.2048x2048' },
  { value: '2560x1440', label: 'paintings.image_size_options.2560x1440' },
  { value: '1440x2560', label: 'paintings.image_size_options.1440x2560' },
  {
    value: '2880x2880',
    label: 'paintings.image_size_options.2880x2880',
    isExperimental: true,
    descriptionKey: 'paintings.help.image_size.experimental'
  },
  {
    value: '3072x2048',
    label: 'paintings.image_size_options.3072x2048',
    isExperimental: true,
    descriptionKey: 'paintings.help.image_size.experimental'
  },
  {
    value: '2048x3072',
    label: 'paintings.image_size_options.2048x3072',
    isExperimental: true,
    descriptionKey: 'paintings.help.image_size.experimental'
  },
  {
    value: '3840x2048',
    label: 'paintings.image_size_options.3840x2048',
    isExperimental: true,
    descriptionKey: 'paintings.help.image_size.experimental'
  },
  {
    value: '2048x3840',
    label: 'paintings.image_size_options.2048x3840',
    isExperimental: true,
    descriptionKey: 'paintings.help.image_size.experimental'
  }
]

export const GPT_IMAGE_2_FAMILY = ['gpt-image-2', 'gpt-image-2-pro', 'gpt-image-2-vip'] as const

export const SUPPORTED_MODELS = ['gpt-image-1', ...GPT_IMAGE_2_FAMILY]

export const MODELS: PaintingModelConfig[] = [
  {
    name: 'gpt-image-1',
    group: 'OpenAI',
    imageSizes: GPT_IMAGE_1_SIZES,
    max_images: 10,
    quality: [{ value: 'auto' }, { value: 'high' }, { value: 'medium' }, { value: 'low' }],
    moderation: [{ value: 'auto' }, { value: 'low' }],
    output_compression_format: [{ value: 'jpeg' }, { value: 'webp' }],
    output_format: [{ value: 'image/png' }, { value: 'image/jpeg' }, { value: 'image/webp' }],
    background: [{ value: 'auto' }, { value: 'transparent' }, { value: 'opaque' }]
  },
  {
    name: 'gpt-image-2',
    group: 'OpenAI',
    imageSizes: GPT_IMAGE_2_SIZES,
    max_images: 10,
    quality: [{ value: 'auto' }, { value: 'high' }, { value: 'medium' }, { value: 'low' }],
    moderation: [{ value: 'auto' }, { value: 'low' }],
    output_compression_format: [{ value: 'jpeg' }, { value: 'webp' }],
    output_format: [{ value: 'image/png' }, { value: 'image/jpeg' }, { value: 'image/webp' }],
    background: [{ value: 'auto' }, { value: 'opaque' }]
  },
  {
    name: 'gpt-image-2-pro',
    group: 'OpenAI',
    imageSizes: GPT_IMAGE_2_SIZES,
    max_images: 10,
    quality: [{ value: 'auto' }, { value: 'high' }, { value: 'medium' }, { value: 'low' }],
    moderation: [{ value: 'auto' }, { value: 'low' }],
    output_compression_format: [{ value: 'jpeg' }, { value: 'webp' }],
    output_format: [{ value: 'image/png' }, { value: 'image/jpeg' }, { value: 'image/webp' }],
    background: [{ value: 'auto' }, { value: 'opaque' }]
  },
  {
    name: 'gpt-image-2-vip',
    group: 'OpenAI',
    imageSizes: GPT_IMAGE_2_SIZES,
    max_images: 10,
    quality: [{ value: 'auto' }, { value: 'high' }, { value: 'medium' }, { value: 'low' }],
    moderation: [{ value: 'auto' }, { value: 'low' }],
    output_compression_format: [{ value: 'jpeg' }, { value: 'webp' }],
    output_format: [{ value: 'image/png' }, { value: 'image/jpeg' }, { value: 'image/webp' }],
    background: [{ value: 'auto' }, { value: 'opaque' }]
  }
]

export const getModelConfig = (modelName?: string) => MODELS.find((model) => model.name === modelName)

export const getFallbackModelConfig = () => MODELS[0]

export const resolveModelConfig = (modelName?: string) => getModelConfig(modelName) ?? getFallbackModelConfig()

export const isGptImage2Family = (modelName?: string) =>
  GPT_IMAGE_2_FAMILY.some((supportedModel) => supportedModel === modelName)

export const DEFAULT_PAINTING: GeneratePainting = {
  id: uuid(),
  urls: [],
  files: [],
  model: '',
  prompt: '',
  quality: 'auto',
  n: 1,
  background: 'auto',
  moderation: 'auto',
  size: 'auto'
}
