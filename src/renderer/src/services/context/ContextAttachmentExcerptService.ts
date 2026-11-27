import { approximateTokenSize } from 'tokenx'

export type AttachmentCoverage = {
  sourceName: string
  mode: 'full' | 'excerpt' | 'metadata-only' | 'summary' | 'missing' | 'unavailable'
  selectedParts: number
  totalParts: number
}

type Attachment = {
  name: string
  body: string
  raw: string
  unavailable: boolean
  partial: boolean
  totalParts?: number
}
type Part = { text: string; locator: string; tokens: number }

export const escapeContextAttribute = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const decodeContextAttribute = (value: string): string =>
  value.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')

// These are the structured, page-labelled blocks produced by the local file
// reader. Keep the boundaries when fitting a checkpoint, rather than treating
// a batch of documents as one string whose middle can be discarded.
export function readCheckpointAttachments(source: string): Attachment[] {
  return [...source.matchAll(/^<file name="([^"\n]+)"([^>]*)>\r?\n([\s\S]*?)\r?\n<\/file>/gm)].map((match) => ({
    name: decodeContextAttribute(match[1]),
    body: match[3],
    raw: match[0],
    unavailable: /(?:extraction="failed"|selection="unavailable")/.test(match[2]),
    partial: /selection="(?:excerpt|metadata-only|unavailable)"/.test(match[2]),
    totalParts: /total-parts="(\d+)"/.test(match[2]) ? Number(/total-parts="(\d+)"/.exec(match[2])?.[1]) : undefined
  }))
}

export function missingCheckpointAttachments(source: string, summary: string): string[] {
  return missingCheckpointAttachmentNames(
    readCheckpointAttachments(source).map((file) => file.name),
    summary
  )
}

export function missingCheckpointAttachmentNames(names: string[], summary: string): string[] {
  const retainedNames = new Set(readCheckpointAttachments(summary).map((file) => file.name))
  return [...new Set(names)].filter((name) => {
    if (retainedNames.size) return !retainedNames.has(name)
    // A filename such as "1 项目.pdf" must not be satisfied by "11 项目.pdf".
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const boundary = /^\d/.test(name) ? '(?<!\\d)' : /^[a-z]/i.test(name) ? '(?<![a-z0-9_.-])' : ''
    return !new RegExp(`${boundary}${escaped}(?![a-z0-9_.-])`, 'i').test(summary)
  })
}

const boundText = (text: string, budget: number, allowLongTokenSplit = false): string => {
  if (budget <= 0) return ''
  if (approximateTokenSize(text) <= budget) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (approximateTokenSize(text.slice(0, middle)) <= budget) low = middle
    else high = middle - 1
  }
  const prefix = text.slice(0, low)
  const boundary = Math.max(
    prefix.lastIndexOf('\n'),
    prefix.lastIndexOf('。') + 1,
    prefix.lastIndexOf('；') + 1,
    prefix.lastIndexOf(' ') + 1
  )
  let end = boundary > low / 2 ? boundary : low
  // Never turn 700 into 70, or split an English identifier into a different
  // fact. The next chunk will receive the intact token during full chunking.
  while (end > 0 && /[a-z0-9._-]/i.test(text[end - 1]) && /[a-z0-9._-]/i.test(text[end] ?? '')) end -= 1
  if (end === 0 && allowLongTokenSplit) end = low
  return text.slice(0, end)
}

function splitParts(body: string): Part[] {
  const labelled = [...body.matchAll(/<part\b([^>]*)>\r?\n([\s\S]*?)\r?\n<\/part>/g)]
  const sections = labelled.length
    ? labelled.map((match) => ({ locator: match[1].trim(), text: match[2] }))
    : [{ locator: '', text: body }]
  const parts: Part[] = []
  for (const section of sections) {
    // Smaller pieces let a narrow question retain a relevant middle page,
    // including when one PDF page contains a very long table or paragraph.
    let text = section.text.trim()
    while (text) {
      let piece = boundText(text, 900, true)
      if (piece.length < text.length) {
        const boundary = piece.lastIndexOf('\n')
        if (boundary > piece.length / 2) piece = piece.slice(0, boundary)
      }
      if (!piece) break
      parts.push({ text: piece, locator: section.locator, tokens: approximateTokenSize(piece) + 24 })
      text = text.slice(piece.length).trimStart()
    }
  }
  return parts
}

/** Keep file identities and locators on every remote summarization chunk. */
export function splitAttachmentCheckpointChunks(
  source: string,
  maxTokens: number,
  splitText: (text: string, maxTokens: number) => string[]
): string[] | undefined {
  const files = readCheckpointAttachments(source)
  if (!files.length) return undefined
  let outside = source
  for (const file of files) outside = outside.replace(file.raw, '')
  const fragments = outside.trim() ? splitText(outside, maxTokens - 64) : []
  for (const file of files) {
    if (approximateTokenSize(file.raw) <= maxTokens - 64) {
      fragments.push(file.raw)
      continue
    }
    const header = `<file name="${escapeContextAttribute(file.name)}">\n`
    const suffix = '\n</file>'
    const available = maxTokens - approximateTokenSize(header + suffix) - 64
    let current = ''
    for (const part of splitParts(file.body)) {
      const rendered = `<part${part.locator ? ` ${part.locator}` : ''}>\n${part.text}\n</part>`
      // splitParts is normally far smaller than a model chunk; the additional
      // split also supports test budgets and unusually long locator strings.
      for (const piece of splitText(rendered, available)) {
        const next = current ? `${current}\n${piece}` : piece
        if (current && approximateTokenSize(next) > available) {
          fragments.push(`${header}${current}${suffix}`)
          current = piece
        } else current = next
      }
    }
    if (current) fragments.push(`${header}${current}${suffix}`)
  }
  const chunks: string[] = []
  let current = ''
  for (const fragment of fragments) {
    const next = current ? `${current}\n\n${fragment}` : fragment
    if (current && approximateTokenSize(next) > maxTokens - 32) {
      chunks.push(current)
      current = fragment
    } else current = next
  }
  if (current) chunks.push(current)
  return chunks
}

const queryTerms = (query: string): string[] => {
  const terms = new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9._-]+|[\u3400-\u9fff]{2,}/g) ?? [])
  for (const match of query.matchAll(/[\u3400-\u9fff]{3,}/g)) {
    for (let index = 0; index < match[0].length - 1; index += 1) terms.add(match[0].slice(index, index + 2))
  }
  return [...terms].slice(0, 128)
}

function selectParts(parts: Part[], budget: number, terms: string[]): Part[] {
  if (parts.reduce((total, part) => total + part.tokens, 0) <= budget) return parts
  const ranked = parts
    .map((part, index) => ({
      index,
      score: terms.reduce(
        (score, term) => score + (part.text.toLowerCase().includes(term) ? Math.min(8, term.length) : 0),
        0
      )
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
  // Always retain identification from the start of each file. Spend the rest
  // on query matches and their following context, then samples throughout the
  // document. No cross-file relevance ranking can evict a whole attachment.
  const relevant = ranked.filter((part) => part.score > 0).flatMap((part) => [part.index, part.index + 1])
  const spread: number[] = []
  for (let stride = Math.max(1, Math.ceil(parts.length / 8)); stride >= 1; stride = Math.floor(stride / 2)) {
    for (let index = 0; index < parts.length; index += stride) spread.push(index)
  }
  const order = [...new Set([0, ...relevant, ...spread, ...ranked.map((part) => part.index)])]
  const selected = new Map<number, Part>()
  let remaining = budget
  for (const index of order) {
    const part = parts[index]
    if (!part || remaining < 48) continue
    const allowance = index === 0 ? Math.min(256, Math.floor(budget * 0.2), remaining - 32) : remaining - 32
    const text = part.tokens <= allowance ? part.text : boundText(part.text, allowance)
    if (!text) continue
    const bounded = { ...part, text, tokens: approximateTokenSize(text) + 24 }
    if (bounded.tokens > remaining) continue
    selected.set(index, bounded)
    remaining -= bounded.tokens
  }
  return [...selected.entries()].sort(([left], [right]) => left - right).map(([, part]) => part)
}

/** Water-fill: unused allowance from a small reference workbook goes to larger PDFs. */
function allocateBudgets(demands: number[], total: number): number[] {
  const allocations = demands.map(() => 0)
  let pending = demands.map((_, index) => index)
  let remaining = Math.max(0, total)
  while (pending.length) {
    const share = Math.floor(remaining / pending.length)
    const small = pending.filter((index) => demands[index] <= share)
    if (!small.length) {
      for (const index of pending) allocations[index] = share
      break
    }
    for (const index of small) {
      allocations[index] = demands[index]
      remaining -= demands[index]
    }
    pending = pending.filter((index) => !small.includes(index))
  }
  return allocations
}

export function fitCheckpointAttachments(
  source: string,
  maxTokens: number,
  query = ''
): { text: string; coverage: AttachmentCoverage[] } | undefined {
  const files = readCheckpointAttachments(source)
  if (!files.length) return undefined
  const limit = Math.max(0, Math.floor(maxTokens))
  const attachmentLabel = '附件：'
  let outside = source
  for (const file of files) outside = outside.replace(file.raw, `[${attachmentLabel}${file.name}]`)
  outside = boundText(outside, Math.min(2_000, Math.floor(limit * 0.12)))
  const notice =
    '[附件覆盖记录：以下逐文件保留原文或节选；节选不等于全文。未展示的内容仍在本地原件中，不能据此称用户未提供文件。]'
  const parts = files.map((file) => (file.unavailable ? [] : splitParts(file.body)))
  const demands = parts.map((items) => items.reduce((total, part) => total + part.tokens, 0))
  const terms = queryTerms(query)
  const metadataOnlyNotice = '[原文保存在本地；当前额度仅容纳文件标识]'
  const fileIdentifiers = files.map(
    (file) =>
      `<file name="${escapeContextAttribute(file.name)}" selection="metadata-only">\n${metadataOnlyNotice}\n</file>`
  )
  let contentBudget = limit - approximateTokenSize([outside, notice, ...fileIdentifiers].join('\n')) - 128

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const allowances = allocateBudgets(demands, contentBudget)
    const coverage: AttachmentCoverage[] = []
    const rendered = files.map((file, index) => {
      const selected = selectParts(parts[index], allowances[index], terms)
      const full =
        !file.partial &&
        selected.length === parts[index].length &&
        selected.every((part, i) => part.text === parts[index][i].text)
      const mode = file.unavailable
        ? 'unavailable'
        : full && parts[index].length
          ? 'full'
          : selected.length
            ? 'excerpt'
            : 'metadata-only'
      const totalParts = file.totalParts ?? parts[index].length
      coverage.push({ sourceName: file.name, mode, selectedParts: selected.length, totalParts })
      const body = selected.length
        ? selected.map((part) => `<part${part.locator ? ` ${part.locator}` : ''}>\n${part.text}\n</part>`).join('\n')
        : file.unavailable
          ? '[原件保存在本地，但本次内容提取失败；不能据此编造文件内容]'
          : '[原文保存在本地；当前额度仅容纳文件标识]'
      return `<file name="${escapeContextAttribute(file.name)}" selection="${mode}" selected-parts="${selected.length}" total-parts="${totalParts}">\n${body}\n</file>`
    })
    const text = `${outside}\n\n${notice}\n\n${rendered.join('\n\n')}`.trim()
    const tokens = approximateTokenSize(text)
    if (tokens <= limit) return { text, coverage }
    if (contentBudget <= 0) return undefined
    contentBudget = Math.max(0, contentBudget - (tokens - limit) - 64)
  }
  return undefined
}

export function checkpointAttachmentCoverage(summary: string, source = summary): AttachmentCoverage[] {
  const retained = readCheckpointAttachments(summary)
  return readCheckpointAttachments(source).map((original) => {
    const file = retained.find((item) => item.name === original.name)
    if (!file) {
      return {
        sourceName: original.name,
        mode: missingCheckpointAttachmentNames([original.name], summary).length
          ? 'missing'
          : original.unavailable
            ? 'unavailable'
            : 'summary',
        selectedParts: 0,
        totalParts: splitParts(original.body).length
      }
    }
    const header = file.raw.split('\n')[0]
    const mode = / selection="(full|excerpt|metadata-only|unavailable)"/.exec(header)?.[1]
    const count = [...file.body.matchAll(/<part\b/g)].length
    return {
      sourceName: file.name,
      mode: file.unavailable
        ? 'unavailable'
        : mode === 'full' || (!mode && file.body === original.body && file.body.trim())
          ? 'full'
          : count
            ? 'excerpt'
            : 'metadata-only',
      selectedParts: Number(/ selected-parts="(\d+)"/.exec(header)?.[1] ?? count),
      totalParts: Number(/ total-parts="(\d+)"/.exec(header)?.[1] ?? splitParts(original.body).length)
    }
  })
}
