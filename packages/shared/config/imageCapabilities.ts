import type {
  ImageCanvasCapabilities,
  ImageCanvasDimension,
  ImageCanvasModel,
  ImageCanvasModelConfiguration,
  ImageCanvasProtocol,
  ImageCanvasRequest
} from './imageCanvas'
import { imageCanvasProtocols } from './imageCanvas'
import { commonImageSizePresets } from './imageSizePresets'

export const imageRatios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']
export const dashscopeFixedSizes = ['1328x1328', '1664x928', '1472x1104', '1104x1472', '928x1664']

// Keep native profiles explicit: a new model version may use a different API.
export function dashscopeImageProfile(id: string) {
  if (/^wanx2\.1-imageedit$/i.test(id)) return 'wan-edit'
  if (/^(?:wanx2\.1-t2i-(?:turbo|plus)|wan2\.2-t2i-(?:flash|plus)|wan2\.5-t2i-preview)$/i.test(id)) return 'wan-text'
  if (/^qwen-image(?:-(?:max|plus)(?:-\d{4}-\d{2}-\d{2})?)?$/i.test(id)) return 'qwen-fixed'
  if (/^qwen-image-edit$/i.test(id)) return 'qwen-edit-auto'
  if (/^qwen-image-edit-(?:plus|max)(?:-\d{4}-\d{2}-\d{2})?$/i.test(id)) return 'qwen-edit'
  if (/^qwen-image-2\.0(?:-pro)?(?:-\d{4}-\d{2}-\d{2})?$/i.test(id)) return 'qwen-modern'
  if (/^qwen-image-(?:2\.1-(?:pro|turbo)|3\.0(?:-pro)?)$/i.test(id)) return 'qwen-unified'
  return undefined
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a
}

export function imageDimension(size: string): ImageCanvasDimension {
  const pixels = /^(\d+)x(\d+)$/.exec(size)
  if (!pixels) return { ratio: 'auto', size }
  const width = Number(pixels[1]),
    height = Number(pixels[2]),
    divisor = gcd(width, height)
  const ratio = `${width / divisor}:${height / divisor}`
  return { ratio: ratio === '7:3' ? '21:9' : ratio, size }
}

export function defaultImageCapabilities(model: ImageCanvasModel): ImageCanvasCapabilities {
  const capabilities = builtinImageCapabilities(model)
  return { ...capabilities, dimensions: commonImageDimensions(model.protocol, capabilities.dimensions) }
}

// Common request preferences. The upstream decides which dimensions it returns.
// Keep pixel presets aligned with Zen API's image_studio_dimensions.go.
export function commonImageDimensions(
  protocol: ImageCanvasProtocol,
  existing: ImageCanvasDimension[] = []
): ImageCanvasDimension[] {
  if (protocol === 'gemini')
    return ['auto', ...imageRatios].flatMap((ratio) =>
      [undefined, '1K', '2K', '4K'].map((resolution) => ({
        ratio,
        size: ratio,
        ...(resolution ? { resolution: resolution as '1K' | '2K' | '4K' } : {})
      }))
    )
  if (!['openai', 'openai-json', 'seedream'].includes(protocol)) return existing
  const sizes = [...commonImageSizePresets.map((item) => item.size), '256x256', '512x512']
  for (const [width, height] of [
    [1024, 1024],
    [1024, 1536],
    [1536, 1024],
    [768, 1024],
    [1024, 768],
    [1024, 1280],
    [1280, 1024],
    [576, 1024],
    [1024, 576],
    [1344, 576]
  ])
    for (const scale of [1, 2, 4]) sizes.push(`${width * scale}x${height * scale}`)
  return [...new Set([...existing.map((item) => item.size), ...sizes])].map(imageDimension)
}

function builtinImageCapabilities(model: ImageCanvasModel): ImageCanvasCapabilities {
  const name = model.id.toLowerCase()
  const base: ImageCanvasCapabilities = {
    dimensions: [{ ratio: 'auto', size: 'auto' }],
    qualities: [],
    backgrounds: [],
    minReferences: 0,
    maxReferences: 0,
    maxImages: 1,
    source: 'builtin'
  }
  if (model.protocol === 'gemini') {
    const resolutions: Array<'1K' | '2K' | '4K' | undefined> = /gemini-3|gemini.*pro.*image/.test(name)
      ? ['1K', '2K', '4K']
      : [undefined]
    return {
      ...base,
      maxReferences: 3,
      dimensions: imageRatios.flatMap((ratio) =>
        resolutions.map((resolution) => ({ ratio, size: ratio, ...(resolution ? { resolution } : {}) }))
      )
    }
  }
  if (model.protocol === 'seedream') {
    // Explicit pixels avoid the old orientation-only mapping. Start with the
    // common 2K combinations; user/channel configuration can add exact sizes.
    return {
      ...base,
      maxReferences: 4,
      dimensions: ['2048x2048', '2304x1728', '1728x2304', '2560x1440', '1440x2560'].map(imageDimension)
    }
  }
  if (model.protocol === 'comfyui')
    return {
      ...base,
      maxReferences: 1,
      supportsMask: true,
      dimensions: ['512x512', '768x512', '512x768', '1024x1024'].map(imageDimension)
    }
  if (model.protocol === 'dashscope') {
    const profile = dashscopeImageProfile(name)
    if (profile === 'wan-edit') return { ...base, minReferences: 1, maxReferences: 1, supportsMask: true }
    if (profile === 'qwen-fixed') return { ...base, dimensions: dashscopeFixedSizes.map(imageDimension) }
    if (profile === 'qwen-edit-auto') return { ...base, minReferences: 1, maxReferences: 3 }
    if (profile?.startsWith('qwen-'))
      return {
        ...base,
        minReferences: profile === 'qwen-edit' ? 1 : 0,
        maxReferences: 3,
        dimensions: ['auto', '1024x1024', '1536x1024', '1024x1536'].map(imageDimension)
      }
    return {
      ...base,
      dimensions: (/wan2\.5/.test(name) ? ['1280x1280', '1440x1440'] : ['1024x1024', '1280x720', '720x1280']).map(
        imageDimension
      )
    }
  }
  if (model.protocol === 'chat') return { ...base, maxReferences: 4 }
  if (/dall-e-3/.test(name))
    return {
      ...base,
      dimensions: ['1024x1024', '1792x1024', '1024x1792'].map(imageDimension),
      qualities: ['standard', 'hd']
    }
  if (/dall-e-2/.test(name))
    return {
      ...base,
      dimensions: ['256x256', '512x512', '1024x1024'].map(imageDimension),
      maxReferences: 1,
      maxImages: 4
    }
  if (/gpt-image|gptimage/.test(name))
    return {
      ...base,
      supportsMask: true,
      maxReferences: 4,
      maxImages: 4,
      dimensions: ['auto', '1024x1024', '1536x1024', '1024x1536'].map(imageDimension),
      qualities: ['auto', 'low', 'medium', 'high'],
      backgrounds: ['auto', 'opaque', 'transparent']
    }
  // Unknown aliases remain usable for generation. Editing and richer options
  // require an explicit local capability configuration or a server declaration.
  return base
}

export function configuredImageCapabilities(settings: ImageCanvasModelConfiguration): ImageCanvasCapabilities {
  if (!settings || !imageCanvasProtocols.includes(settings.protocol)) throw new Error('invalid_capabilities')
  const list = (value: unknown, allowed: (item: string) => boolean, max = 40): string[] => {
    if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== 'string' || !allowed(item)))
      throw new Error('invalid_capabilities')
    return [...new Set(value)]
  }
  const sizes = list(settings.sizes, (s) => /^(?:auto|[1-9]\d{1,3}x[1-9]\d{1,3})$/.test(s))
  const ratios = list(settings.ratios, (s) => imageRatios.includes(s), 10)
  const resolutions = list(settings.resolutions, (s) => ['1K', '2K', '4K'].includes(s), 3) as Array<'1K' | '2K' | '4K'>
  const qualities = list(settings.qualities, (s) => ['auto', 'low', 'medium', 'high', 'standard', 'hd'].includes(s), 6)
  const backgrounds = list(settings.backgrounds, (s) => ['auto', 'opaque', 'transparent'].includes(s), 3)
  if (
    ![settings.minReferences, settings.maxReferences, settings.maxImages].every(Number.isInteger) ||
    settings.minReferences < 0 ||
    settings.maxReferences < settings.minReferences ||
    settings.maxReferences > 4 ||
    settings.maxImages < 1 ||
    settings.maxImages > (['openai', 'openai-json'].includes(settings.protocol) ? 4 : 1)
  )
    throw new Error('invalid_capabilities')
  if (
    !['openai', 'openai-json'].includes(settings.protocol) &&
    (qualities.length || backgrounds.some((s) => s !== 'auto' && s !== 'opaque'))
  )
    throw new Error('invalid_capabilities')
  if (settings.imageField !== undefined && !['image', 'images'].includes(settings.imageField))
    throw new Error('invalid_capabilities')
  if (settings.supportsMask !== undefined && typeof settings.supportsMask !== 'boolean')
    throw new Error('invalid_capabilities')
  if (settings.supportsMask && !['openai', 'openai-json', 'comfyui', 'dashscope'].includes(settings.protocol))
    throw new Error('invalid_capabilities')
  if (settings.workflow !== undefined) {
    if (settings.protocol !== 'comfyui' || typeof settings.workflow !== 'string' || settings.workflow.length > 200000)
      throw new Error('invalid_capabilities')
    if (settings.workflow.trim()) {
      let workflow: unknown
      try {
        workflow = JSON.parse(settings.workflow)
      } catch {
        throw new Error('invalid_workflow')
      }
      if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow) || Object.keys(workflow).length > 300)
        throw new Error('invalid_workflow')
      for (const node of Object.values(workflow)) {
        if (
          !node ||
          typeof node !== 'object' ||
          typeof node.class_type !== 'string' ||
          !node.inputs ||
          typeof node.inputs !== 'object' ||
          Array.isArray(node.inputs)
        )
          throw new Error('invalid_workflow')
      }
    }
  }
  const dimensions =
    settings.protocol === 'gemini'
      ? ratios.flatMap((ratio) =>
          (resolutions.length ? resolutions : [undefined]).map((resolution) => ({
            ratio,
            size: ratio,
            ...(resolution ? { resolution } : {})
          }))
        )
      : sizes.map(imageDimension)
  if (!dimensions.length) throw new Error('invalid_capabilities')
  return {
    dimensions,
    qualities,
    backgrounds,
    minReferences: settings.minReferences,
    maxReferences: settings.maxReferences,
    maxImages: settings.maxImages,
    supportsMask: !!settings.supportsMask,
    source: 'custom'
  }
}

export function validateImageCapabilities(input: ImageCanvasRequest, capabilities: ImageCanvasCapabilities): void {
  if (
    (input.mask || input.expansion) &&
    (!capabilities.supportsMask || input.references.length !== 1 || (input.mask && input.expansion))
  )
    throw new Error('image_mask_unsupported')
  if (
    input.references.length < capabilities.minReferences ||
    input.references.length > capabilities.maxReferences ||
    input.count > capabilities.maxImages
  )
    throw new Error('image_reference_or_count_unsupported')
  const ratio = input.aspectRatio
  // Workbench requests carry an explicit ratio. Legacy canvas requests retain
  // their protocol validation path so saved projects remain readable.
  if (
    ratio !== undefined &&
    !capabilities.dimensions.some(
      (item) => item.ratio === ratio && item.size === input.size && item.resolution === input.resolution
    )
  )
    throw new Error('image_dimensions_unsupported')
  if (input.quality && input.quality !== 'auto' && !capabilities.qualities.includes(input.quality))
    throw new Error('image_quality_unsupported')
  if (input.background && input.background !== 'auto' && !capabilities.backgrounds.includes(input.background))
    throw new Error('background_unsupported')
}
