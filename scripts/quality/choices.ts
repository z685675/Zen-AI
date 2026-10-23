import { type FileKind, fileKinds, type Module } from './matrix'
import { providerURL } from './models'

const moduleKinds = ['files', 'history', 'memory'] as const satisfies readonly Module[]
export const DEFAULT_QUALITY_PROVIDER_URL = 'https://zenai.925636.xyz/v1'

interface VisionReservation {
  maxImageTokensPerRequest: number
  acknowledgedTokenBilling: true
}

interface ChoiceIO {
  ask: (question: string) => Promise<string>
  write: (text: string) => void
}

export async function chooseProviderURL(io: ChoiceIO) {
  while (true) {
    const answer = (
      await io.ask(`Provider地址，包含/v1（回车默认 ${DEFAULT_QUALITY_PROVIDER_URL}；可填写其他地址，q取消）`)
    ).trim()
    if (answer.toLowerCase() === 'q') throw new Error('已取消选择，没有发送模型生成请求。')
    let baseURL: string
    try {
      baseURL = providerURL(answer || DEFAULT_QUALITY_PROVIDER_URL)
    } catch {
      io.write('API地址无效。请填写不含密钥、查询参数的HTTPS地址，或本机回环HTTP地址；回车使用默认地址。\n')
      continue
    }
    io.write(`本次API地址：${baseURL}\n`)
    return baseURL
  }
}

/** Empty input explicitly accepts the complete list shown by the interactive prompt. */
export function parseChoices<T extends string>(answer: string, choices: readonly T[]): T[] {
  const normalized = answer.trim().toLowerCase()
  if (!normalized || normalized === 'all' || normalized === '全部') return [...choices]
  const parts = normalized.split(/[,，、;；\s]+/).filter(Boolean)
  if (!parts.length || parts.some((part) => !choices.includes(part as T)))
    throw new Error(`选择无效；请输入 ${choices.join('、')} 中的英文单词，回车或输入 all 全选。`)
  if (new Set(parts).size !== parts.length) throw new Error('选项重复，请不要重复填写同一个选项。')
  return parts as T[]
}

async function askChoices<T extends string>(
  io: ChoiceIO,
  question: string,
  choices: readonly T[],
  validate?: (selected: T[]) => void
) {
  while (true) {
    const answer = await io.ask(question)
    if (answer.trim().toLowerCase() === 'q') throw new Error('已取消选择，没有发送模型生成请求。')
    try {
      const selected = parseChoices(answer, choices)
      validate?.(selected)
      io.write(`已选择：${selected.join(', ')}\n`)
      return selected
    } catch (error) {
      io.write((error instanceof Error ? error.message : '选择无效，请重新输入。') + '\n')
    }
  }
}

export function chooseModules(io: ChoiceIO, profile: string) {
  return askChoices(
    io,
    '选择测试模块：files=文件、history=历史、memory=记忆；回车默认全部，可只输入英文单词（如 files），多选用逗号或空格分隔，q取消' +
      (profile === 'deep' ? '；deep必须包含memory' : ''),
    moduleKinds,
    (selected) => {
      if (profile === 'deep' && !selected.includes('memory')) throw new Error('deep必须包含memory，请重新选择。')
    }
  )
}

export function chooseFormats(io: ChoiceIO) {
  return askChoices(
    io,
    '选择文件格式：json,docx,xlsx,pptx,pdf,png,jpg；回车默认全部，可只输入英文格式（如 xlsx），多选用逗号或空格分隔，q取消。另包含大附件与损坏文件；png/jpg稍后需确认图片Token计价和预留',
    fileKinds
  )
}

async function chooseImageReservation(io: ChoiceIO): Promise<VisionReservation | undefined> {
  while (true) {
    const answer = (
      await io.ask(
        '图片测试：确认此Provider的图片按输入Token计费后，填写每请求图像Token预留（1–200000的整数，建议8192）。这是预算预留，不是价格或实际用量；此项不可留空。不确定填b返回文件格式选择，q取消'
      )
    )
      .trim()
      .toLowerCase()
    if (answer === 'q') throw new Error('已取消选择，没有发送模型生成请求。')
    if (['b', 'back', '返回'].includes(answer)) return undefined
    const tokens = Number(answer)
    if (!/^\d+$/.test(answer) || !Number.isSafeInteger(tokens) || tokens < 1 || tokens > 200000) {
      io.write(
        '图片Token预留不能为空，且必须是1–200000的整数；确认按Token计费后可填8192。不确定请填b返回，不会退出或启动模型测试。\n'
      )
      continue
    }
    io.write(`已确认图片按Token计费；每请求图像Token预留：${tokens}（非实际消耗）。\n`)
    return { maxImageTokensPerRequest: tokens, acknowledgedTokenBilling: true }
  }
}

/** Returning from billing always reopens the explicit format choice; never silently drop image coverage. */
export async function chooseFileInputs(io: ChoiceIO): Promise<{ formats: FileKind[]; vision?: VisionReservation }> {
  while (true) {
    const formats = await chooseFormats(io)
    if (!formats.some((format) => ['png', 'jpg'].includes(format))) return { formats }
    const vision = await chooseImageReservation(io)
    if (vision) return { formats, vision }
    io.write('已返回文件格式选择；尚未开始模型测试。若不确定图片计费，可选json,docx,xlsx,pptx,pdf暂不测图片。\n')
  }
}
