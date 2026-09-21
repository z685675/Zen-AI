import type { GeneratePainting } from '@renderer/types'
import { uuid } from '@renderer/utils'

type PaintingOption<Value extends string = string> = {
  value: Value
  label?: string
  descriptionKey?: string
  isExperimental?: boolean
}

export type PaintingRequestProtocol = 'openai' | 'grok-imagine'

export type PaintingModelConfig = {
  name: string
  group: string
  imageSizes: PaintingOption[]
  /** Optional aspect-ratio selector used by providers such as Grok Imagine. */
  aspectRatios?: PaintingOption[]
  /** Request protocol used by the image endpoint. */
  requestProtocol?: PaintingRequestProtocol
  /** Maximum number of reference images accepted by the model's edit endpoint. */
  imageInputLimit?: number
  max_images: number
  quality: PaintingOption[]
  moderation: PaintingOption[]
  output_compression: PaintingOption[]
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
    value: '3840x2160',
    label: 'paintings.image_size_options.3840x2160',
    isExperimental: true,
    descriptionKey: 'paintings.help.image_size.experimental'
  },
  {
    value: '2160x3840',
    label: 'paintings.image_size_options.2160x3840',
    isExperimental: true,
    descriptionKey: 'paintings.help.image_size.experimental'
  }
]

export const GPT_IMAGE_2_FAMILY = ['gpt-image-2', 'gpt-image-2-pro', 'gpt-image-2-vip'] as const
// Gateways may expose the new model with or without the separator after
// `image`. Keep both spellings so the model keeps the correct GPT-image
// controls instead of falling back to the legacy GPT-image-1 config.
export const GPT_IMAGE_2_5_FAMILY = ['gpt-image2.5', 'gpt-image-2.5'] as const

export const GROK_IMAGINE_FAMILY = [
  'grok-imagine-image',
  'grok-imagine-image-2.0',
  'grok-imagine-image-quality'
] as const

export const GROK_IMAGINE_MAX_IMAGE_INPUTS = 5

const GROK_IMAGINE_MODEL_REGEX = /^grok[-_.]?imagine[-_.]?image(?:[-_.].*)?$/i
const GROK_IMAGINE_2_MODEL_REGEX = /^grok[-_.]?imagine[-_.]?image[-_.]?2(?:\.0)?(?:[-_.].*)?$/i
const GROK_IMAGINE_QUALITY_MODEL_REGEX = /(?:quality|pro)/i

const GROK_IMAGINE_ASPECT_RATIOS: PaintingOption[] = [
  { value: 'auto' },
  { value: '1:1' },
  { value: '3:4' },
  { value: '4:3' },
  { value: '9:16' },
  { value: '16:9' },
  { value: '2:3' },
  { value: '3:2' },
  { value: '9:19.5' },
  { value: '19.5:9' },
  { value: '9:20' },
  { value: '20:9' },
  { value: '1:2' },
  { value: '2:1' },
  { value: '21:9' },
  { value: '5:2' }
]

const GROK_IMAGINE_RESOLUTIONS: PaintingOption[] = [
  { value: '1k', label: '1K' },
  { value: '2k', label: '2K' }
]

const createGrokImagineConfig = (name: string, quality: PaintingOption[] = [{ value: 'auto' }]) =>
  ({
    name,
    group: 'Grok',
    imageSizes: GROK_IMAGINE_RESOLUTIONS,
    aspectRatios: GROK_IMAGINE_ASPECT_RATIOS,
    requestProtocol: 'grok-imagine' as const,
    imageInputLimit: GROK_IMAGINE_MAX_IMAGE_INPUTS,
    max_images: 10,
    quality,
    moderation: [],
    output_compression: [],
    output_format: [],
    background: []
  }) satisfies PaintingModelConfig

export const SUPPORTED_MODELS = ['gpt-image-1', ...GPT_IMAGE_2_FAMILY, ...GPT_IMAGE_2_5_FAMILY, ...GROK_IMAGINE_FAMILY]

const BACKGROUND_OPTIONS: PaintingOption[] = [{ value: 'auto' }, { value: 'opaque' }, { value: 'transparent' }]

export const MODELS: PaintingModelConfig[] = [
  {
    name: 'gpt-image-1',
    group: 'OpenAI',
    imageSizes: GPT_IMAGE_1_SIZES,
    max_images: 10,
    quality: [{ value: 'auto' }, { value: 'high' }, { value: 'medium' }, { value: 'low' }],
    moderation: [{ value: 'auto' }, { value: 'low' }],
    output_compression: [{ value: '50' }, { value: '70' }, { value: '90' }],
    output_format: [{ value: 'png' }, { value: 'jpeg' }, { value: 'webp' }],
    background: BACKGROUND_OPTIONS
  },
  ...[...GPT_IMAGE_2_FAMILY, ...GPT_IMAGE_2_5_FAMILY].map(
    (name): PaintingModelConfig => ({
      name,
      group: 'OpenAI',
      imageSizes: GPT_IMAGE_2_SIZES,
      max_images: 10,
      quality: [{ value: 'auto' }, { value: 'high' }, { value: 'medium' }, { value: 'low' }],
      moderation: [{ value: 'auto' }, { value: 'low' }],
      output_compression: [{ value: '50' }, { value: '70' }, { value: '90' }],
      output_format: [{ value: 'png' }, { value: 'jpeg' }, { value: 'webp' }],
      background: BACKGROUND_OPTIONS
    })
  ),
  createGrokImagineConfig('grok-imagine-image'),
  createGrokImagineConfig('grok-imagine-image-2.0', [{ value: 'auto' }, { value: 'low' }, { value: 'medium' }]),
  createGrokImagineConfig('grok-imagine-image-quality')
]

export const getModelConfig = (modelName?: string) => MODELS.find((model) => model.name === modelName)

export const getFallbackModelConfig = () => MODELS[0]

export const isGptImage2Family = (modelName?: string) => {
  const normalizedModelName = modelName?.trim().toLowerCase().split('/').pop()
  return Boolean(
    normalizedModelName &&
      (/^gpt-image-2(?:[-.].*)?$/.test(normalizedModelName) || /^gpt-image2\.5(?:[-.].*)?$/.test(normalizedModelName))
  )
}

export const isGrokImagineFamily = (modelName?: string) => {
  const normalizedModelName = modelName?.trim().toLowerCase().split('/').pop()
  return Boolean(normalizedModelName && GROK_IMAGINE_MODEL_REGEX.test(normalizedModelName))
}

export const resolveModelConfig = (modelName?: string) => {
  const normalizedModelName = modelName?.trim().toLowerCase().split('/').pop() ?? ''
  const grokModelConfigName = isGrokImagineFamily(normalizedModelName)
    ? GROK_IMAGINE_2_MODEL_REGEX.test(normalizedModelName)
      ? 'grok-imagine-image-2.0'
      : GROK_IMAGINE_QUALITY_MODEL_REGEX.test(normalizedModelName)
        ? 'grok-imagine-image-quality'
        : 'grok-imagine-image'
    : undefined

  return (
    getModelConfig(modelName) ??
    (grokModelConfigName ? getModelConfig(grokModelConfigName) : undefined) ??
    (isGptImage2Family(modelName)
      ? /^gpt-image2\.5(?:[-.].*)?$/.test(modelName?.trim().toLowerCase().split('/').pop() ?? '')
        ? getModelConfig('gpt-image2.5')
        : getModelConfig('gpt-image-2')
      : undefined) ??
    getFallbackModelConfig()
  )
}

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
