import { UploadOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import { AiProvider } from '@renderer/aiCore'
import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import Scrollbar from '@renderer/components/Scrollbar'
import InfoTooltip from '@renderer/components/TooltipIcons/InfoTooltip'
import TranslateButton from '@renderer/components/TranslateButton'
import { isImageGenerationEndpointModel } from '@renderer/config/models'
import { LanguagesEnum } from '@renderer/config/translate'
import { usePaintings } from '@renderer/hooks/usePaintings'
import { usePaintingProviders } from '@renderer/hooks/useProvider'
import { useSettings } from '@renderer/hooks/useSettings'
import {
  getPaintingsBackgroundOptionsLabel,
  getPaintingsImageSizeOptionsLabel,
  getPaintingsModerationOptionsLabel,
  getPaintingsQualityOptionsLabel
} from '@renderer/i18n/label'
import PaintingsList from '@renderer/pages/paintings/components/PaintingsList'
import {
  DEFAULT_PAINTING,
  isGptImage2Family,
  resolveModelConfig,
  SUPPORTED_MODELS
} from '@renderer/pages/paintings/config/NewApiConfig'
import FileManager from '@renderer/services/FileManager'
import { translateText } from '@renderer/services/TranslateService'
import type { FileMetadata, PaintingAction } from '@renderer/types'
import { uuid } from '@renderer/utils'
import { getFriendlyPaintingErrorMessage } from '@renderer/utils/friendlyError'
import { getZenClientHeaders } from '@renderer/utils/zenClientHeaders'
import { Button, Empty, InputNumber, Modal, Select, Tooltip, Upload } from 'antd'
import TextArea from 'antd/es/input/TextArea'
import { Maximize2 } from 'lucide-react'
import type { FC } from 'react'
import React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import styled from 'styled-components'

import SendMessageButton from '../home/Inputbar/SendMessageButton'
import { SettingTitle } from '../settings'
import Artboard from './components/Artboard'
import ProviderSelect from './components/ProviderSelect'
import { checkProviderEnabled, resolveSmartAutoSize } from './utils'

const logger = loggerService.withContext('NewApiPage')

type ComposerMode = 'create' | 'continue' | 'upload-edit'

interface NewApiPaintingTask {
  controller: AbortController
  inputPreviewUrls: string[]
}

const activeNewApiPaintingTasks = new Map<string, NewApiPaintingTask>()
const newApiPaintingTaskListeners = new Set<() => void>()

const notifyNewApiPaintingTaskListeners = () => {
  newApiPaintingTaskListeners.forEach((listener) => listener())
}

const getActiveNewApiPaintingIds = () => new Set(activeNewApiPaintingTasks.keys())

const getNewApiPaintingTaskPreviewUrls = (paintingId: string) =>
  activeNewApiPaintingTasks.get(paintingId)?.inputPreviewUrls ?? []

const registerNewApiPaintingTask = (
  paintingId: string,
  controller: AbortController,
  inputPreviewUrls: string[] = []
) => {
  activeNewApiPaintingTasks.set(paintingId, { controller, inputPreviewUrls })
  notifyNewApiPaintingTaskListeners()
}

const unregisterNewApiPaintingTask = (paintingId: string) => {
  const task = activeNewApiPaintingTasks.get(paintingId)
  task?.inputPreviewUrls.forEach((url) => URL.revokeObjectURL(url))
  activeNewApiPaintingTasks.delete(paintingId)
  notifyNewApiPaintingTaskListeners()
}

const cancelNewApiPaintingTask = (paintingId: string) => {
  const task = activeNewApiPaintingTasks.get(paintingId)
  task?.controller.abort()
  unregisterNewApiPaintingTask(paintingId)
}

const subscribeNewApiPaintingTasks = (listener: () => void) => {
  newApiPaintingTaskListeners.add(listener)
  return () => {
    newApiPaintingTaskListeners.delete(listener)
  }
}

const NewApiPage: FC<{ Options: string[] }> = ({ Options }) => {
  const { openai_image_generate, addPainting, removePainting, updatePainting } = usePaintings()
  const [currentImageIndex, setCurrentImageIndex] = useState(0)
  const [loadingPaintingIds, setLoadingPaintingIds] = useState<Set<string>>(getActiveNewApiPaintingIds)
  const [spaceClickCount, setSpaceClickCount] = useState(0)
  const [isTranslating, setIsTranslating] = useState(false)
  const [selectedPaintingId, setSelectedPaintingId] = useState<string | null>(null)
  const [composerMode, setComposerMode] = useState<ComposerMode>('create')
  const [uploadedEditFiles, setUploadedEditFiles] = useState<File[]>([])
  const [isPromptEditorOpen, setIsPromptEditorOpen] = useState(false)
  const [draft, setDraft] = useState<PaintingAction>({ ...DEFAULT_PAINTING })

  const { t } = useTranslation()
  const providers = usePaintingProviders()
  const location = useLocation()
  const routeName = location.pathname.split('/').pop() || 'new-api'
  const navigate = useNavigate()
  const { autoTranslateWithSpace } = useSettings()
  const textareaRef = useRef<any>(null)
  const spaceClickTimer = useRef<NodeJS.Timeout>(null)
  const selectableProviders = useMemo(
    () => providers.filter((provider) => Options.includes(provider.id)),
    [Options, providers]
  )
  const newApiProvider = selectableProviders.find((p) => p.id === routeName) || selectableProviders[0]
  const providerId = newApiProvider?.id ?? ''
  const providerModels = useMemo(() => newApiProvider?.models ?? [], [newApiProvider?.models])
  const providerApiHost = newApiProvider?.apiHost ?? ''

  // Image tasks belong to the image workspace. Provider only decides how new tasks are executed.
  const paintings = useMemo(() => openai_image_generate, [openai_image_generate])

  const selectedPainting = useMemo(
    () => paintings.find((painting) => painting.id === selectedPaintingId) ?? null,
    [paintings, selectedPaintingId]
  )

  const artboardPainting = selectedPainting ?? { ...draft, files: [], urls: [] }
  const isArtboardLoading = loadingPaintingIds.has(artboardPainting.id)
  const taskPreviewUrls = isArtboardLoading ? getNewApiPaintingTaskPreviewUrls(artboardPainting.id) : []
  const composerHint = useMemo(() => {
    if (composerMode === 'continue' && selectedPainting) {
      return t('paintings.composer_continue_hint')
    }
    if (composerMode === 'upload-edit' && uploadedEditFiles.length > 0) {
      return t('paintings.composer_upload_hint')
    }
    return null
  }, [composerMode, selectedPainting, t, uploadedEditFiles.length])

  const modelOptions = useMemo(() => {
    return providerModels
      .filter((model) => Boolean(newApiProvider && isImageGenerationEndpointModel(model, newApiProvider)))
      .map((model) => ({
        label: model.name,
        value: model.id,
        custom: !SUPPORTED_MODELS.includes(model.id),
        group: model.group
      }))
  }, [newApiProvider, providerModels])

  const resolveAvailableModel = useCallback(
    (...candidates: Array<string | undefined>) => {
      const modelIds = new Set(modelOptions.map((model) => model.value))
      return (
        candidates.find((modelId): modelId is string => Boolean(modelId && modelIds.has(modelId))) ||
        modelOptions[0]?.value ||
        ''
      )
    },
    [modelOptions]
  )

  const groupedModelOptions = useMemo(() => {
    return modelOptions.reduce<Record<string, typeof modelOptions>>((acc, option) => {
      const groupName = option.group
      if (!acc[groupName]) {
        acc[groupName] = []
      }
      acc[groupName].push(option)
      return acc
    }, {})
  }, [modelOptions])

  const selectedModelConfig = useMemo(() => resolveModelConfig(draft.model), [draft.model])
  const isGptImage2 = isGptImage2Family(selectedModelConfig.name)
  const imageSizeOptions = selectedModelConfig.imageSizes
  const qualityOptions = selectedModelConfig.quality
  const moderationOptions = selectedModelConfig.moderation
  const backgroundOptions = selectedModelConfig.background
  const smartAutoSize = useMemo(
    () => (draft.size === 'auto' && isGptImage2 ? resolveSmartAutoSize(draft.model, draft.prompt) : undefined),
    [draft.model, draft.prompt, draft.size, isGptImage2]
  )

  const smartAutoSizeSummary = useMemo(() => {
    if (!smartAutoSize || draft.size !== 'auto' || !isGptImage2) {
      return null
    }

    if (smartAutoSize.reason === 'conflict') {
      return t('paintings.image_size_auto.conflict')
    }

    if (smartAutoSize.reason === 'fallback_auto') {
      return t('paintings.image_size_auto.fallback')
    }

    if (!smartAutoSize.size) {
      return null
    }

    return t('paintings.image_size_auto.matched', {
      target: getPaintingsImageSizeOptionsLabel(smartAutoSize.size)
    })
  }, [draft.size, isGptImage2, smartAutoSize, t])

  const updateDraft = useCallback((updates: Partial<PaintingAction>) => {
    setDraft((prev) => ({ ...prev, ...updates }))
  }, [])

  const createEmptyDraft = useCallback(
    (overrides: Partial<PaintingAction> = {}): PaintingAction => {
      const model = resolveAvailableModel(overrides.model, draft.model)
      return {
        ...DEFAULT_PAINTING,
        id: uuid(),
        prompt: draft.prompt || '',
        ...overrides,
        providerId,
        model
      }
    },
    [draft.model, draft.prompt, providerId, resolveAvailableModel]
  )

  const syncDraftFromPainting = useCallback(
    (painting: PaintingAction) => {
      setDraft((prev) => ({
        ...prev,
        providerId,
        model: resolveAvailableModel(painting.model, prev.model),
        prompt: '',
        size: painting.size || prev.size || DEFAULT_PAINTING.size,
        quality: painting.quality || prev.quality || DEFAULT_PAINTING.quality,
        moderation: painting.moderation || prev.moderation || DEFAULT_PAINTING.moderation,
        background: painting.background || prev.background || DEFAULT_PAINTING.background,
        n: painting.n || prev.n || DEFAULT_PAINTING.n
      }))
    },
    [providerId, resolveAvailableModel]
  )

  useEffect(() => {
    if (!providerId) {
      return
    }

    setDraft((prev) => ({
      ...prev,
      providerId,
      model: resolveAvailableModel(prev.model),
      size: prev.size || DEFAULT_PAINTING.size,
      quality: prev.quality || DEFAULT_PAINTING.quality,
      moderation: prev.moderation || DEFAULT_PAINTING.moderation,
      background: prev.background || DEFAULT_PAINTING.background,
      n: prev.n || DEFAULT_PAINTING.n
    }))
  }, [providerId, resolveAvailableModel])

  useEffect(() => {
    if (!selectedPaintingId) {
      return
    }

    if (!selectedPainting) {
      setSelectedPaintingId(null)
      setComposerMode('create')
      return
    }

    syncDraftFromPainting(selectedPainting)
  }, [selectedPainting, selectedPaintingId, syncDraftFromPainting])

  useEffect(() => {
    if (!imageSizeOptions.some((option) => option.value === draft.size)) {
      updateDraft({ size: imageSizeOptions[0]?.value ?? DEFAULT_PAINTING.size })
    }
  }, [draft.size, imageSizeOptions, updateDraft])

  useEffect(() => {
    if (!qualityOptions.some((option) => option.value === draft.quality)) {
      updateDraft({ quality: qualityOptions[0]?.value ?? DEFAULT_PAINTING.quality })
    }
  }, [draft.quality, qualityOptions, updateDraft])

  useEffect(() => {
    if (!moderationOptions.some((option) => option.value === draft.moderation)) {
      updateDraft({ moderation: moderationOptions[0]?.value ?? DEFAULT_PAINTING.moderation })
    }
  }, [draft.moderation, moderationOptions, updateDraft])

  useEffect(() => {
    if (!backgroundOptions.some((option) => option.value === draft.background)) {
      updateDraft({ background: backgroundOptions[0]?.value ?? DEFAULT_PAINTING.background })
    }
  }, [backgroundOptions, draft.background, updateDraft])

  useEffect(() => {
    const unsubscribe = subscribeNewApiPaintingTasks(() => {
      setLoadingPaintingIds(getActiveNewApiPaintingIds())
    })

    setLoadingPaintingIds(getActiveNewApiPaintingIds())
    return unsubscribe
  }, [])

  useEffect(() => {
    const timer = spaceClickTimer.current
    return () => {
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [])

  const handleProviderChange = (nextProviderId: string) => {
    const currentRouteName = location.pathname.split('/').pop()
    if (nextProviderId !== currentRouteName) {
      navigate(`../${nextProviderId}`, { replace: true })
    }
  }

  const handleModelChange = (value: string) => {
    const modelConfig = resolveModelConfig(value)
    const defaultModeration =
      modelConfig.moderation.find((option) => option.value === DEFAULT_PAINTING.moderation)?.value ??
      modelConfig.moderation[0]?.value ??
      DEFAULT_PAINTING.moderation
    updateDraft({
      model: value,
      size: modelConfig.imageSizes[0]?.value ?? DEFAULT_PAINTING.size,
      quality: modelConfig.quality[0]?.value ?? DEFAULT_PAINTING.quality,
      moderation: defaultModeration,
      background: modelConfig.background[0]?.value ?? DEFAULT_PAINTING.background,
      n: 1
    })
  }

  const handleImageUpload = (file: File) => {
    setUploadedEditFiles((prev) => [...prev, file])
    setComposerMode('upload-edit')
    setSelectedPaintingId(null)
    setCurrentImageIndex(0)
    return false
  }

  const handlePastedFiles = useCallback((files: File[]) => {
    if (files.length === 0) {
      return
    }
    setUploadedEditFiles((prev) => [...prev, ...files])
    setComposerMode('upload-edit')
    setSelectedPaintingId(null)
    setCurrentImageIndex(0)
  }, [])

  const handleDeleteUploadedImage = useCallback((index: number) => {
    setUploadedEditFiles((prev) => {
      const nextFiles = prev.filter((_, fileIndex) => fileIndex !== index)
      if (nextFiles.length === 0) {
        setComposerMode('create')
      }
      setCurrentImageIndex((currentIndex) => {
        if (nextFiles.length === 0) {
          return 0
        }
        return Math.min(currentIndex, Math.max(0, nextFiles.length - 1))
      })
      return nextFiles
    })
  }, [])

  const getClipboardImageFiles = (clipboardData: DataTransfer) => {
    const files = Array.from(clipboardData.files).filter((file) => file.type.startsWith('image/'))

    if (files.length > 0) {
      return files
    }

    const seen = new Set<string>()
    return Array.from(clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
      .filter((file) => {
        const key = `${file.type}-${file.size}`
        if (seen.has(key)) {
          return false
        }
        seen.add(key)
        return true
      })
  }

  const handleShowAddModelPopup = () => {
    navigate(providerId ? `/settings/provider?id=${providerId}` : '/settings/provider')
  }

  const onSelectPainting = (painting: PaintingAction) => {
    setSelectedPaintingId(painting.id)
    setComposerMode('continue')
    setUploadedEditFiles([])
    setCurrentImageIndex(0)
    syncDraftFromPainting(painting)
  }

  const handleCreateNew = () => {
    setComposerMode('create')
    setSelectedPaintingId(null)
    setUploadedEditFiles([])
    setCurrentImageIndex(0)
    setDraft((prev) =>
      createEmptyDraft({
        prompt: prev.prompt
      })
    )
  }

  const downloadImages = async (urls: string[]) => {
    const downloadedFiles = await Promise.all(
      urls.map(async (url) => {
        try {
          if (!url?.trim()) {
            logger.error('Image URL is empty')
            window.toast.warning(t('message.empty_url'))
            return null
          }
          return await window.api.file.download(url)
        } catch (error) {
          logger.error('Failed to download image:', error as Error)
          if (
            error instanceof Error &&
            (error.message.includes('Failed to parse URL') || error.message.includes('Invalid URL'))
          ) {
            window.toast.warning(t('message.empty_url'))
          }
          return null
        }
      })
    )

    return downloadedFiles.filter((file): file is FileMetadata => file !== null)
  }

  const handleError = (error: unknown) => {
    if (error instanceof Error && error.name !== 'AbortError') {
      window.modal.error({
        content: getFriendlyPaintingErrorMessage(error),
        centered: true
      })
    }
  }

  const throwIfAborted = (signal: AbortSignal) => {
    if (signal.aborted) {
      throw new DOMException('Image generation was cancelled', 'AbortError')
    }
  }

  const createResultPainting = useCallback(
    (prompt: string) => {
      const sourceInfo =
        composerMode === 'continue' && selectedPainting?.files?.length
          ? {
              sourcePaintingId: selectedPainting.id,
              sourceImageIndex: currentImageIndex,
              sourceImageCount: selectedPainting.files.length
            }
          : {}

      return {
        ...createEmptyDraft(),
        providerId,
        prompt,
        model: draft.model,
        size: draft.size,
        quality: draft.quality,
        moderation: draft.moderation,
        background: draft.background,
        n: draft.n,
        files: [],
        urls: [],
        ...sourceInfo
      }
    },
    [
      composerMode,
      createEmptyDraft,
      currentImageIndex,
      draft.background,
      draft.model,
      draft.moderation,
      draft.n,
      draft.quality,
      draft.size,
      providerId,
      selectedPainting?.files?.length,
      selectedPainting?.id
    ]
  )

  const onGenerate = async () => {
    if (!newApiProvider) {
      return
    }

    await checkProviderEnabled(newApiProvider, t)

    const prompt = textareaRef.current?.resizableTextArea?.textArea?.value || draft.prompt || ''
    updateDraft({ prompt })

    const ai = new AiProvider(newApiProvider)

    if (!ai.getApiKey()) {
      window.modal.error({
        content: t('error.no_api_key'),
        centered: true
      })
      return
    }

    if (!draft.model || !prompt) {
      return
    }

    const resultPainting = createResultPainting(prompt)
    const controller = new AbortController()
    const inputPreviewUrls =
      composerMode === 'upload-edit' ? uploadedEditFiles.map((file) => URL.createObjectURL(file)) : []
    registerNewApiPaintingTask(resultPainting.id, controller, inputPreviewUrls)
    addPainting('openai_image_generate', resultPainting)
    setSelectedPaintingId(resultPainting.id)
    setComposerMode('continue')
    setCurrentImageIndex(0)

    let body: string | FormData = ''
    const headers: Record<string, string> = {
      Authorization: `Bearer ${ai.getApiKey()}`,
      ...getZenClientHeaders(providerApiHost)
    }
    let generationUrl = providerApiHost.replace(/\/v1$/, '') + `/v1/images/generations`
    let editUrl = providerApiHost.replace(/\/v1$/, '') + `/v1/images/edits`
    if (newApiProvider.id === 'aionly') {
      generationUrl = providerApiHost.replace(/\/v1$/, '') + `/openai/v1/images/generations`
      editUrl = providerApiHost.replace(/\/v1$/, '') + `/openai/v1/images/edits`
    }

    try {
      throwIfAborted(controller.signal)

      const continueImages =
        composerMode === 'continue' && selectedPainting?.files?.length
          ? await Promise.all(
              selectedPainting.files
                .filter((_, index) => index === currentImageIndex)
                .map(async (file, index) => {
                  const { data, mime } = await window.api.file.binaryImage(FileManager.getStorageFileName(file))
                  const ext = file.ext ? (file.ext.startsWith('.') ? file.ext : `.${file.ext}`) : ''
                  const fileName = file.origin_name || file.name || `image_${index + 1}${ext}`
                  return new File([data], fileName, {
                    type: mime,
                    lastModified: new Date(file.created_at).getTime()
                  })
                })
            )
          : []

      throwIfAborted(controller.signal)

      const inputImages = composerMode === 'upload-edit' ? uploadedEditFiles : continueImages
      const shouldEdit = inputImages.length > 0

      if (!shouldEdit) {
        const resolvedSize =
          draft.size === 'auto' ? (smartAutoSize?.size === undefined ? undefined : smartAutoSize.size) : draft.size

        body = JSON.stringify({
          prompt,
          model: draft.model,
          size: resolvedSize,
          background: draft.background === 'auto' ? undefined : draft.background,
          n: draft.n,
          quality: draft.quality === 'auto' ? undefined : draft.quality,
          moderation: draft.moderation === 'auto' ? undefined : draft.moderation
        })
        headers['Content-Type'] = 'application/json'
      } else {
        const formData = new FormData()
        formData.append('prompt', prompt)
        formData.append('model', draft.model)
        if (draft.background && draft.background !== 'auto') {
          formData.append('background', draft.background)
        }
        if (draft.size && draft.size !== 'auto') {
          formData.append('size', draft.size)
        }
        if (draft.quality && draft.quality !== 'auto') {
          formData.append('quality', draft.quality)
        }
        if (draft.moderation && draft.moderation !== 'auto') {
          formData.append('moderation', draft.moderation)
        }
        inputImages.forEach((file) => formData.append('image', file))
        body = formData
      }

      const response = await fetch(shouldEdit ? editUrl : generationUrl, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal
      })

      throwIfAborted(controller.signal)

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error?.message || t('paintings.generate_failed'))
      }

      const data = await response.json()
      throwIfAborted(controller.signal)

      const urls = data.data.filter((item) => item.url).map((item) => item.url)
      const base64s = data.data.filter((item) => item.b64_json).map((item) => item.b64_json)

      let validFiles: FileMetadata[] = []

      if (urls.length > 0) {
        validFiles = await downloadImages(urls)
        throwIfAborted(controller.signal)
      }

      if (base64s.length > 0) {
        validFiles = await Promise.all(base64s.map((base64) => window.api.file.saveBase64Image(base64)))
        throwIfAborted(controller.signal)
      }

      await FileManager.addFiles(validFiles)
      throwIfAborted(controller.signal)

      const completedPainting = {
        ...resultPainting,
        files: validFiles,
        urls: urls.length > 0 ? urls : []
      }

      updatePainting('openai_image_generate', completedPainting)
      if (composerMode === 'upload-edit') {
        setComposerMode('continue')
        setSelectedPaintingId((currentId) => (currentId === resultPainting.id ? completedPainting.id : currentId))
      }
    } catch (error: unknown) {
      void removePainting('openai_image_generate', resultPainting)
      setSelectedPaintingId((currentId) =>
        currentId === resultPainting.id ? (selectedPainting?.id ?? null) : currentId
      )
      handleError(error)
    } finally {
      unregisterNewApiPaintingTask(resultPainting.id)
    }
  }

  const handleRetry = async (painting: PaintingAction) => {
    registerNewApiPaintingTask(painting.id, new AbortController())
    try {
      const validFiles = await downloadImages(painting.urls)
      await FileManager.addFiles(validFiles)
      const retriedPainting = {
        ...painting,
        files: validFiles
      }
      updatePainting('openai_image_generate', retriedPainting)
      setSelectedPaintingId(retriedPainting.id)
      syncDraftFromPainting(retriedPainting)
    } catch (error) {
      handleError(error)
    } finally {
      unregisterNewApiPaintingTask(painting.id)
    }
  }

  const onDeletePainting = (paintingToDelete: PaintingAction) => {
    const targetIndex = paintings.findIndex((painting) => painting.id === paintingToDelete.id)
    const nextPainting =
      selectedPaintingId === paintingToDelete.id
        ? paintings[targetIndex + 1] || paintings[targetIndex - 1] || null
        : selectedPainting

    void removePainting('openai_image_generate', paintingToDelete)

    if (nextPainting) {
      setSelectedPaintingId(nextPainting.id)
      setComposerMode('continue')
      syncDraftFromPainting(nextPainting)
      return
    }

    setSelectedPaintingId(null)
    setComposerMode('create')
  }

  const onCancel = () => {
    cancelNewApiPaintingTask(artboardPainting.id)
  }

  const nextImage = () => {
    const activePreviewUrls = taskPreviewUrls.length > 0 ? taskPreviewUrls : uploadedPreviewUrls
    const totalImages = artboardPainting.files.length > 0 ? artboardPainting.files.length : activePreviewUrls.length
    if (totalImages === 0) return
    const step = artboardPainting.files.length === 0 && activePreviewUrls.length > 1 ? 9 : 1
    setCurrentImageIndex((prev) => (prev + step) % totalImages)
  }

  const prevImage = () => {
    const activePreviewUrls = taskPreviewUrls.length > 0 ? taskPreviewUrls : uploadedPreviewUrls
    const totalImages = artboardPainting.files.length > 0 ? artboardPainting.files.length : activePreviewUrls.length
    if (totalImages === 0) return
    const step = artboardPainting.files.length === 0 && activePreviewUrls.length > 1 ? 9 : 1
    setCurrentImageIndex((prev) => (prev - step + totalImages) % totalImages)
  }

  const translate = async () => {
    if (isTranslating || !draft.prompt) {
      return
    }

    try {
      setIsTranslating(true)
      const translatedText = await translateText(draft.prompt, LanguagesEnum.enUS)
      updateDraft({ prompt: translatedText })
    } catch (error) {
      logger.error('Translation failed:', error as Error)
    } finally {
      setIsTranslating(false)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (autoTranslateWithSpace && event.key === ' ') {
      const nextSpaceClickCount = spaceClickCount + 1
      setSpaceClickCount(nextSpaceClickCount)
      if (spaceClickTimer.current) {
        clearTimeout(spaceClickTimer.current)
      }
      spaceClickTimer.current = setTimeout(() => {
        setSpaceClickCount(0)
      }, 200)

      if (nextSpaceClickCount >= 2) {
        setSpaceClickCount(0)
        void translate()
      }
      return
    }
  }

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = getClipboardImageFiles(event.clipboardData)
    if (imageFiles.length === 0) {
      return
    }
    event.preventDefault()
    handlePastedFiles(imageFiles)
  }

  const uploadedPreviewUrls = useMemo(
    () => uploadedEditFiles.map((file) => URL.createObjectURL(file)),
    [uploadedEditFiles]
  )

  useEffect(() => {
    return () => {
      uploadedPreviewUrls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [uploadedPreviewUrls])

  if (!newApiProvider) {
    return (
      <Container>
        <Navbar>
          <NavbarCenter style={{ borderRight: 'none' }}>{t('paintings.title')}</NavbarCenter>
        </Navbar>
        <ContentContainer id="content-container">
          <LeftContainer>
            <Empty
              style={{ marginTop: 24 }}
              description={t('paintings.no_image_generation_model', {
                endpoint_type: t('endpoint_type.image-generation')
              })}>
              <Button type="primary" onClick={() => navigate('/settings/provider')}>
                {t('paintings.go_to_settings')}
              </Button>
            </Empty>
          </LeftContainer>
          <MainContainer />
        </ContentContainer>
      </Container>
    )
  }

  return (
    <Container>
      <Navbar>
        <NavbarCenter style={{ borderRight: 'none' }}>{t('paintings.title')}</NavbarCenter>
      </Navbar>
      <ContentContainer id="content-container">
        <LeftContainer>
          <SettingTitle style={{ marginBottom: 5 }}>{t('common.provider')}</SettingTitle>

          <ProviderSelect provider={newApiProvider} options={Options} onChange={handleProviderChange} />

          {modelOptions.length === 0 && (
            <Empty
              style={{ marginTop: 24 }}
              description={t('paintings.no_image_generation_model', {
                endpoint_type: t('endpoint_type.image-generation')
              })}>
              <Button type="primary" onClick={handleShowAddModelPopup}>
                {t('paintings.go_to_settings')}
              </Button>
            </Empty>
          )}

          {modelOptions.length > 0 && (
            <>
              <SettingTitle style={{ marginTop: 20 }}>{t('paintings.model')}</SettingTitle>
              <Select value={draft.model} onChange={handleModelChange} style={{ width: '100%', marginBottom: 15 }}>
                {Object.entries(groupedModelOptions).map(([groupName, options]) => (
                  <Select.OptGroup label={groupName} key={groupName}>
                    {(options as typeof modelOptions).map((model) => (
                      <Select.Option value={model.value} key={model.value}>
                        {model.label}
                      </Select.Option>
                    ))}
                  </Select.OptGroup>
                ))}
              </Select>

              {imageSizeOptions.length > 0 && (
                <>
                  <SettingTitleRow>
                    <SettingTitle>{t('paintings.image.size')}</SettingTitle>
                    <InfoTooltip
                      title={t(
                        isGptImage2 ? 'paintings.help.image_size.gpt_image_2' : 'paintings.help.image_size.default'
                      )}
                    />
                  </SettingTitleRow>
                  <Select
                    value={draft.size}
                    onChange={(value) => updateDraft({ size: value })}
                    style={{ width: '100%', marginBottom: 15 }}>
                    {imageSizeOptions.map((size) => (
                      <Select.Option value={size.value} key={size.value}>
                        {getPaintingsImageSizeOptionsLabel(size.value, size.label, size.isExperimental) ?? size.value}
                      </Select.Option>
                    ))}
                  </Select>
                  {smartAutoSizeSummary && <SettingHint>{smartAutoSizeSummary}</SettingHint>}
                </>
              )}

              {qualityOptions.length > 0 && (
                <>
                  <SettingTitleRow>
                    <SettingTitle>{t('paintings.quality')}</SettingTitle>
                    <InfoTooltip title={t('paintings.help.quality')} />
                  </SettingTitleRow>
                  <Select
                    value={draft.quality}
                    onChange={(value) => updateDraft({ quality: value })}
                    style={{ width: '100%', marginBottom: 15 }}>
                    {qualityOptions.map((quality) => (
                      <Select.Option value={quality.value} key={quality.value}>
                        {getPaintingsQualityOptionsLabel(quality.value) ?? quality.value}
                      </Select.Option>
                    ))}
                  </Select>
                </>
              )}

              {moderationOptions.length > 0 && (
                <>
                  <SettingTitleRow>
                    <SettingTitle>{t('paintings.moderation')}</SettingTitle>
                    <InfoTooltip title={t('paintings.help.moderation')} />
                  </SettingTitleRow>
                  <Select
                    value={draft.moderation}
                    onChange={(value) => updateDraft({ moderation: value })}
                    style={{ width: '100%', marginBottom: 15 }}>
                    {moderationOptions.map((moderation) => (
                      <Select.Option value={moderation.value} key={moderation.value}>
                        {getPaintingsModerationOptionsLabel(moderation.value) ?? moderation.value}
                      </Select.Option>
                    ))}
                  </Select>
                </>
              )}

              {backgroundOptions.length > 0 && (
                <>
                  <SettingTitleRow>
                    <SettingTitle>{t('paintings.background')}</SettingTitle>
                    <InfoTooltip
                      overlayInnerStyle={{ whiteSpace: 'pre-line' }}
                      title={t(
                        isGptImage2 ? 'paintings.help.background.gpt_image_2' : 'paintings.help.background.default'
                      )}
                    />
                  </SettingTitleRow>
                  <Select
                    value={draft.background}
                    onChange={(value) => updateDraft({ background: value })}
                    style={{ width: '100%', marginBottom: 15 }}>
                    {backgroundOptions.map((background) => (
                      <Select.Option value={background.value} key={background.value}>
                        {getPaintingsBackgroundOptionsLabel(background.value) ?? background.value}
                      </Select.Option>
                    ))}
                  </Select>
                </>
              )}

              {selectedModelConfig?.max_images && (
                <>
                  <SettingTitle>{t('paintings.number_images')}</SettingTitle>
                  <InputNumber
                    min={1}
                    max={selectedModelConfig.max_images}
                    value={draft.n || 1}
                    onChange={(value) => {
                      if (value !== null && value !== undefined) {
                        updateDraft({ n: Number(value) })
                      }
                    }}
                    style={{ width: '100%', marginBottom: 15 }}
                  />
                </>
              )}
            </>
          )}
        </LeftContainer>

        <MainContainer>
          <Artboard
            painting={artboardPainting}
            isLoading={isArtboardLoading}
            currentImageIndex={currentImageIndex}
            onPrevImage={prevImage}
            onNextImage={nextImage}
            onCancel={onCancel}
            retry={handleRetry}
            previewUrls={taskPreviewUrls.length > 0 ? taskPreviewUrls : uploadedPreviewUrls}
            onDeletePreview={taskPreviewUrls.length > 0 ? undefined : handleDeleteUploadedImage}
            prompt={artboardPainting.prompt}
            imageCover={
              <CanvasGuide>
                <GuideText>{t('paintings.canvas_guide_primary')}</GuideText>
                <GuideTextMuted>{t('paintings.canvas_guide_secondary')}</GuideTextMuted>
                <ImageUploadButton
                  accept="image/png, image/jpeg, image/gif"
                  maxCount={16}
                  multiple
                  showUploadList={false}
                  beforeUpload={handleImageUpload}>
                  <Button icon={<UploadOutlined />}>{t('paintings.canvas_upload_action')}</Button>
                </ImageUploadButton>
              </CanvasGuide>
            }
          />
          <InputContainer>
            {composerHint && <ComposerHint>{composerHint}</ComposerHint>}
            <Textarea
              ref={textareaRef}
              variant="borderless"
              disabled={isArtboardLoading}
              value={draft.prompt}
              spellCheck={false}
              onChange={(event) => updateDraft({ prompt: event.target.value })}
              placeholder={
                isTranslating
                  ? t('paintings.translating')
                  : draft.model?.startsWith('imagen-')
                    ? t('paintings.prompt_placeholder_en')
                    : t('paintings.prompt_placeholder_edit')
              }
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
            />
            <Toolbar>
              <ToolbarMenu>
                <Tooltip title={t('paintings.expand_prompt_editor')}>
                  <ExpandPromptButton
                    type="text"
                    shape="circle"
                    icon={<Maximize2 size={17} />}
                    aria-label={t('paintings.expand_prompt_editor')}
                    disabled={isArtboardLoading}
                    onClick={() => setIsPromptEditorOpen(true)}
                  />
                </Tooltip>
                <TranslateButton
                  text={textareaRef.current?.resizableTextArea?.textArea?.value}
                  onTranslated={(translatedText) => updateDraft({ prompt: translatedText })}
                  disabled={isArtboardLoading || isTranslating}
                  isLoading={isTranslating}
                  style={{ marginRight: 6, borderRadius: '50%' }}
                />
                <SendMessageButton sendMessage={onGenerate} disabled={isArtboardLoading} />
              </ToolbarMenu>
            </Toolbar>
          </InputContainer>
          <Modal
            title={t('paintings.prompt_editor_title')}
            open={isPromptEditorOpen}
            width={920}
            centered
            onCancel={() => setIsPromptEditorOpen(false)}
            footer={
              <Button type="primary" onClick={() => setIsPromptEditorOpen(false)}>
                {t('common.close')}
              </Button>
            }>
            <ExpandedPromptTextarea
              autoFocus
              value={draft.prompt}
              disabled={isArtboardLoading}
              spellCheck={false}
              onChange={(event) => updateDraft({ prompt: event.target.value })}
              placeholder={
                isTranslating
                  ? t('paintings.translating')
                  : draft.model?.startsWith('imagen-')
                    ? t('paintings.prompt_placeholder_en')
                    : t('paintings.prompt_placeholder_edit')
              }
            />
          </Modal>
        </MainContainer>

        <PaintingsList
          namespace="openai_image_generate"
          paintings={paintings}
          selectedPainting={selectedPainting}
          onSelectPainting={onSelectPainting}
          onDeletePainting={onDeletePainting}
          onNewPainting={handleCreateNew}
          loadingPaintingIds={loadingPaintingIds}
        />
      </ContentContainer>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  height: 100%;
`

const ContentContainer = styled.div`
  display: flex;
  flex: 1;
  flex-direction: row;
  height: 100%;
  background-color: var(--color-background);
  overflow: hidden;
`

const LeftContainer = styled(Scrollbar)`
  display: flex;
  flex: 1;
  flex-direction: column;
  height: 100%;
  padding: 20px;
  background-color: var(--color-background);
  max-width: var(--assistants-width);
  border-right: 0.5px solid var(--color-border);
`

const MainContainer = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  height: 100%;
  background-color: var(--color-background);
`

const InputContainer = styled.div`
  display: flex;
  flex-direction: column;
  height: 95px;
  min-height: 95px;
  max-height: 95px;
  flex-shrink: 0;
  position: relative;
  border: 1px solid var(--color-border-soft);
  transition:
    border-color 160ms ease,
    box-shadow 160ms ease;
  margin: 0 20px 15px 20px;
  border-radius: 10px;
  overflow: hidden;

  &:focus-within {
    border-color: var(--color-border);
    box-shadow: 0 0 0 1px var(--color-border-soft);
  }
`

const Textarea = styled(TextArea)`
  padding: 10px;
  border-radius: 0;
  display: flex;
  flex: 1;
  resize: none !important;
  overflow-y: auto !important;
  width: 100%;
`

const Toolbar = styled.div`
  display: flex;
  flex-direction: row;
  justify-content: flex-end;
  padding: 0 8px;
  height: 40px;
`

const ToolbarMenu = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
`

const ExpandPromptButton = styled(Button)`
  display: inline-flex;
  align-items: center;
  justify-content: center;
`

const ExpandedPromptTextarea = styled(TextArea)`
  height: min(56vh, 560px) !important;
  min-height: 280px;
  padding: 12px;
  line-height: 1.65;
  resize: vertical !important;
`

const SettingTitleRow = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
`

const SettingHint = styled.div`
  margin-top: -8px;
  margin-bottom: 14px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-text-3);
`

const ImageUploadButton = styled(Upload)`
  display: inline-flex;
`

const CanvasGuide = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  text-align: center;
  max-width: 420px;
`

const GuideText = styled.div`
  font-size: 18px;
  line-height: 1.6;
  color: var(--color-text-1);
`

const GuideTextMuted = styled.div`
  font-size: 14px;
  line-height: 1.7;
  color: var(--color-text-3);
`

const ComposerHint = styled.div`
  align-self: flex-start;
  margin: 8px 10px 0;
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
`

export default NewApiPage
