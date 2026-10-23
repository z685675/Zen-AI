import { readFile } from 'node:fs/promises'
import path from 'node:path'

export interface Scenario {
  id: string
  prompt: string
  required?: string[]
}

export const quick: Scenario[] = [
  {
    id: 'quick-01',
    prompt: '你好。帮我记住这次活动总预算8000元，备用金2000元不能动。先简单确认，暂时不用出方案，也不要联网或生成文件。'
  },
  {
    id: 'quick-02',
    prompt:
      '更正一下，总预算改成5500元，备用金仍然不能动。现在最多能用于活动的费用是多少？只需简短回答，不要联网或生成文件。',
    required: ['3500']
  }
]

// Import only the twenty fenced USER prompts. The answer card and surrounding instructions stay out of model input.
export async function loadCostPrompts(file: string): Promise<Scenario[]> {
  const document = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '')
  if (path.extname(file).toLowerCase() === '.txt') {
    const sections = [...document.matchAll(/^第(\d+)轮[ \t]*\r?\n([\s\S]*?)(?=^第\d+轮[ \t]*\r?\n|$(?![\s\S]))/gm)]
    if (sections.length !== 20 || sections.some((item, index) => Number(item[1]) !== index + 1 || !item[2].trim()))
      throw new Error('文本题库必须依次包含第1轮到第20轮，每轮标题独占一行，后面填写非空提示词。')
    return sections.map((item) => ({ id: `cost-${item[1].padStart(2, '0')}`, prompt: item[2].trim() }))
  }
  const matches = [...document.matchAll(/^### 第(\d+)轮[^\r\n]*\r?\n([\s\S]*?)(?=^### |^## |$(?![\s\S]))/gm)]
  const rounds = matches.map((match) => {
    const blocks = [...match[2].matchAll(/^(?:```|~~~)text\r?\n([\s\S]*?)^(?:```|~~~)[ \t]*$/gm)]
    if (blocks.length !== 1) throw new Error(`第${match[1]}轮不是唯一提示词。`)
    return { id: `cost-${String(match[1]).padStart(2, '0')}`, prompt: blocks[0][1].trim(), round: Number(match[1]) }
  })
  if (rounds.length !== 20 || rounds.some((item, index) => item.round !== index + 1))
    throw new Error('成本题库必须依次包含完整20轮。')
  return rounds.map(({ id, prompt }) => ({ id, prompt }))
}

export function checkAnswer(answer: string, required: string[] = []) {
  const normalized = answer.normalize('NFKC').replace(/\s+/g, ' ').trim()
  return {
    nonempty: normalized.length > 0,
    missing: required.filter((fact) => {
      const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fact)
      if (date)
        return !new RegExp(`${date[1]}[年./-]0?${Number(date[2])}[月./-]0?${Number(date[3])}(?:日|\\b)`).test(
          normalized
        )
      return /^\d+$/.test(fact)
        ? !new RegExp(`(^|[^\\d.])${fact.replace(/\B(?=(\d{3})+(?!\d))/g, '[,，]?')}(?:\\.0+)?(?![\\d.])`).test(
            normalized
          )
        : !normalized.includes(fact.normalize('NFKC'))
    })
  }
}

// Optional judge responses are untrusted data, never commands. Hard assertions are not overridable.
export function validateJudge(value: unknown, answer: string, factIds: string[]) {
  if (!value || typeof value !== 'object' || !('facts' in value) || !Array.isArray(value.facts))
    throw new Error('Invalid judge result')
  const facts = value.facts as Array<{ id?: unknown; verdict?: unknown; quote?: unknown }>
  if (facts.length !== factIds.length || new Set(facts.map((fact) => fact.id)).size !== facts.length)
    throw new Error('Missing/duplicate judge facts')
  return facts.map((fact) => {
    if (
      typeof fact.id !== 'string' ||
      !factIds.includes(fact.id) ||
      !['correct', 'incorrect', 'uncertain'].includes(String(fact.verdict)) ||
      typeof fact.quote !== 'string'
    )
      throw new Error('Invalid judge fact')
    return {
      ...fact,
      reviewRequired: fact.verdict === 'uncertain' || !fact.quote.trim() || !answer.includes(fact.quote)
    }
  })
}
