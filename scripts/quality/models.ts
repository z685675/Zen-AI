export type ModelFamily = 'gpt' | 'claude' | 'gemini' | 'grok' | 'other'
export interface AvailableModel {
  id: string
  family: ModelFamily | null
  nonChat: boolean
}

export function providerURL(value: string) {
  const url = new URL(value)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new Error('Provider必须为不带凭据/查询参数的HTTPS或明确loopback地址。')
  return url.href.replace(/\/$/, '')
}

export function parseModels(value: unknown): AvailableModel[] {
  if (
    !value ||
    typeof value !== 'object' ||
    !('data' in value) ||
    !Array.isArray(value.data) ||
    value.data.length > 10000
  )
    throw new Error('模型列表格式无效或超过10000个。')
  const ids = new Set<string>()
  for (const item of value.data) {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !item.id.trim() ||
      item.id !== item.id.trim() ||
      item.id.length > 200 ||
      /[\p{Cc}\p{Cf}]/u.test(item.id)
    )
      throw new Error('模型列表包含无效ID，未自动修正或猜测。')
    ids.add(item.id)
  }
  return [...ids]
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map((id) => {
      const name = id.toLowerCase()
      const family: ModelFamily | null = /(?:^|[/_.-])(?:gpt|chatgpt|o[134])(?:\d|[_.-]|$)/.test(name)
        ? 'gpt'
        : /(?:^|[/_.-])claude(?:[_.-]|$)/.test(name)
          ? 'claude'
          : /(?:^|[/_.-])gemini(?:[_.-]|$)/.test(name)
            ? 'gemini'
            : /(?:^|[/_.-])grok(?:[_.-]|$)/.test(name)
              ? 'grok'
              : null
      return {
        id,
        family,
        nonChat: /(?:image|imagen|imagine|embedding|embed-|rerank|whisper|tts|sora|veo|video)/i.test(id)
      }
    })
}

/** Metadata only. Explicitly selected env key; no saved provider scanning, redirects or model generation. */
export async function fetchModels(input: { baseURL: string; credentialEnv: string; signal?: AbortSignal }) {
  const url = providerURL(input.baseURL)
  if (!/^ZEN_QUALITY_[A-Z0-9_]+_KEY$/.test(input.credentialEnv)) throw new Error('凭据引用名称无效。')
  const key = process.env[input.credentialEnv]
  if (!key?.trim() || /\s/.test(key))
    throw new Error(`请先在本机设置专用测试凭据环境变量：${input.credentialEnv}；不要粘贴到聊天或配置文件。`)
  const controller = new AbortController()
  const abort = () => controller.abort()
  input.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 15000)
  if (input.signal?.aborted) abort()
  try {
    const response = await fetch(url + '/models', {
      headers: { authorization: `Bearer ${key}` },
      redirect: 'manual',
      signal: controller.signal
    })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error(`获取模型列表失败：HTTP ${response.status}；不会自动重试或发送生成请求。`)
    }
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength
      if (size > 2 * 1024 * 1024) {
        controller.abort()
        throw new Error('模型列表超过2MiB。')
      }
      chunks.push(chunk)
    }
    let value: unknown
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new Error('模型列表不是有效JSON。')
    }
    const models = parseModels(value)
    if (!models.length) throw new Error('服务未返回可选模型；不使用内置默认模型替代。')
    return models
  } catch (error) {
    if (controller.signal.aborted) throw new Error('获取模型列表已取消、超时或超过大小限制；没有发起生成。')
    if (error instanceof TypeError) throw new Error('获取模型列表连接失败；请检查地址、网络或代理。')
    throw error
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', abort)
  }
}

export function selectModels(models: AvailableModel[], answer: string) {
  const parts = answer.trim().split(/[,，\s]+/)
  if (parts.some((part) => !/^[1-9]\d*$/.test(part))) throw new Error('请输入一个或多个模型序号，例如1或1,5,9。')
  const indexes = parts.map(Number)
  if (new Set(indexes).size !== indexes.length) throw new Error('不能重复选择同一个模型。')
  return indexes.map((index) => {
    const model = models[index - 1]
    if (!model) throw new Error('模型序号超出列表，请重新选择。')
    if (model.nonChat) throw new Error(`${model.id}疑似非对话模型，请选择文字/多模态对话模型。`)
    return model
  })
}

export async function chooseModels(input: {
  baseURL: string
  credentialEnv: string
  ask: (question: string) => Promise<string>
  write: (text: string) => void
  discover?: typeof fetchModels
  signal?: AbortSignal
  selectionPrompt?: string
}) {
  let models = await (input.discover ?? fetchModels)(input)
  let filter = ''
  while (true) {
    if (!models.some((model) => !model.nonChat))
      throw new Error('当前列表没有可选对话模型；请检查测试Key权限或更换Provider，不自动补选其他模型。')
    const visible = models
      .map((model, index) => ({ model, index }))
      .filter(({ model }) => model.id.toLowerCase().includes(filter))
    input.write(
      visible
        .slice(0, 100)
        .map(({ model, index }) => `${index + 1}. ${model.id}${model.nonChat ? '（非对话，不可选）' : ''}`)
        .join('\n') + '\n'
    )
    input.write(`共${models.length}个模型，本次筛选${visible.length}个，最多展示100个；序号始终对应完整列表。\n`)
    const answer = (
      await input.ask(input.selectionPrompt ?? '选一个或多个序号（如1或1,5,9）；/关键词搜索，/清空恢复，r刷新，q取消')
    ).trim()
    if (answer === 'q') throw new Error('已取消选模，没有保存配置或发送生成请求。')
    if (answer === 'r') {
      models = await (input.discover ?? fetchModels)(input)
      filter = ''
      continue
    }
    if (answer.startsWith('/')) {
      filter = answer === '/清空' ? '' : answer.slice(1).trim().toLowerCase()
      continue
    }
    try {
      return selectModels(models, answer)
    } catch (error) {
      input.write((error instanceof Error ? error.message : '选择无效') + '\n')
    }
  }
}
