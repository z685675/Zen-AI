import type { Scenario } from './scenarios'

export const fileKinds = ['json', 'docx', 'xlsx', 'pptx', 'pdf', 'png', 'jpg'] as const
export type FileKind = (typeof fileKinds)[number]
export type Module = 'files' | 'history' | 'memory'
export interface MatrixScenario extends Scenario {
  kind?: 'file-read' | 'file-create' | 'file-multiple' | 'file-corrupt' | 'history' | 'memory'
  format?: FileKind
  forbidden?: string[]
}

/** Explicit expansion is shared by preview and executor. Never silently turn release/deep into quick. */
export function matrixScenarios(input: {
  profile: string
  modules?: Module[]
  formats?: FileKind[]
  deepCharacters?: number
}): MatrixScenario[] {
  if (input.profile === 'cost') return [] // The operator's separate, hashed twenty-round bank is loaded later.
  const scenarios: MatrixScenario[] = [
    {
      id: 'quick-01',
      prompt:
        '你好。帮我记住这次活动总预算8000元，备用金2000元不能动。先简单确认，暂时不用出方案，也不要联网或生成文件。'
    },
    {
      id: 'quick-02',
      prompt:
        '更正一下，总预算改成5500元，备用金仍然不能动。现在最多能用于活动的费用是多少？只需简短回答，不要联网或生成文件。',
      required: ['3500']
    }
  ]
  if (!['release', 'deep'].includes(input.profile)) return scenarios
  for (const module of input.modules ?? []) {
    if (module === 'files') {
      for (const format of input.formats ?? fileKinds) {
        scenarios.push({
          id: `read-${format}`,
          kind: 'file-read',
          format,
          prompt: '请阅读我上传的资料，告诉我项目编号、三笔金额的合计，以及负责人。请依据附件回答，不要联网。',
          required: ['ZX7319', '700', 'LIN']
        })
        if (['docx', 'xlsx', 'pptx', 'pdf'].includes(format))
          scenarios.push({ id: `create-${format}`, kind: 'file-create', format, prompt: '', required: [] })
      }
      scenarios.push({
        id: 'read-multiple-large',
        kind: 'file-multiple',
        prompt:
          '请阅读我上传的两个JSON文件，把两份amounts里的所有金额相加，告诉我合计是多少，只读原件，不要联网或生成文件。',
        required: ['100']
      })
      scenarios.push({
        id: 'read-corrupt',
        kind: 'file-corrupt',
        prompt: '请看看这个文件能不能正常读取。如果文件损坏或无法打开，请直接说明，不要猜测里面的数据，也不要联网。'
      })
    } else if (module === 'history') {
      scenarios.push({
        id: 'history',
        kind: 'history',
        prompt: '刚才活动可用的费用是多少？请只简短回答，不要联网。',
        required: ['3500']
      })
    } else if (module === 'memory') {
      scenarios.push(...memoryScenarios(input.profile === 'deep' ? (input.deepCharacters ?? 0) : 12000))
    }
  }
  return scenarios
}

export function memoryScenarios(characters: number): MatrixScenario[] {
  if (!Number.isSafeInteger(characters) || characters < 1000 || characters > 1000000)
    throw new Error('记忆资料长度必须明确在1000至1000000字符之间；字符数不冒充Token数。')
  const blocks: string[] = []
  // Repeated filler alone exaggerates caching. Seeded distinct records exercise real history delivery.
  let state = 7319
  let length = 0
  while (length < characters) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const block = `归档项目${blocks.length}，批次${state}，此项只用于留档，无需逐项回复。\n`
    blocks.push(block)
    length += block.length
  }
  const filler = blocks.join('').slice(0, characters)
  const half = Math.floor(filler.length / 2)
  const source = `项目编号ZX7319；负责人LIN；预算8800元。\n${filler.slice(0, half)}\n文件口令MIDDLE4621。\n${filler.slice(half)}\n最终交付日2026-12-18；原文件只能读取，不能覆盖。`
  const chunks = source.match(/[\s\S]{1,24000}/g)!
  return [
    ...chunks.map(
      (chunk, index): MatrixScenario => ({
        id: index === 0 ? 'memory-source' : `memory-source-${index + 1}`,
        kind: 'memory',
        prompt: `接下来是同一份工作资料的第${index + 1}/${chunks.length}部分，请暂时记住，简单确认即可，不要联网。\n${chunk}`
      })
    ),
    {
      id: 'memory-correction-1',
      kind: 'memory',
      prompt: '更正：预算改为6600元，负责人换成ZHOU。其他内容不变，简单确认即可。'
    },
    {
      id: 'memory-correction-2',
      kind: 'memory',
      prompt: '再次更正：预算最终为5500元，其中2000元不能动。负责人仍为ZHOU。请按最新信息记录，暂时不用总结。'
    },
    {
      id: 'memory-recall',
      kind: 'memory',
      prompt:
        '现在请列出项目编号、最新负责人、最新总预算、可支配金额、文件口令、交付日，以及对原文件的要求。只依据前面的资料，不要联网，不要生成文件。',
      required: ['ZX7319', 'ZHOU', '5500', '3500', 'MIDDLE4621', '2026-12-18'],
      forbidden: ['8800', '6600', '负责人LIN']
    }
  ]
}

export function tasksForEntry(scenarios: MatrixScenario[], profile: string, entry: string) {
  const tasks = scenarios.filter((scenario) => entry === 'assistant' || scenario.kind !== 'file-create')
  if (profile === 'quick' && entry === 'assistant') tasks.push({ id: 'tool', prompt: '' })
  return tasks
}

/** Keep prerequisite pairs and memory chunks together. Preview and execution use this same schedule. */
export function tasksForTarget(
  scenarios: MatrixScenario[],
  profile: string,
  entry: string,
  allocation: 'all-models' | 'mixed',
  index: number,
  count: number
) {
  const tasks = tasksForEntry(scenarios, profile, entry)
  if (allocation === 'all-models') return tasks
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= count ||
    ['deep', 'cost'].includes(profile)
  )
    throw new Error('混用分配需要至少一个模型，且只支持quick/release验收。')
  const group = (task: MatrixScenario) =>
    task.format ? `file-${task.format}` : task.kind === 'memory' ? 'memory' : task.id
  const groups = [...new Set(scenarios.filter((task) => !task.id.startsWith('quick-')).map(group))]
  return tasks.filter(
    (task) => task.id.startsWith('quick-') || task.id === 'tool' || groups.indexOf(group(task)) % count === index
  )
}
