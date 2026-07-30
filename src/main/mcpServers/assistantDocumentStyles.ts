export const VISUAL_STYLE_IDS = [
  'executive',
  'corporate',
  'consulting',
  'finance',
  'government',
  'legal',
  'academic',
  'research',
  'technology',
  'product',
  'data',
  'startup',
  'sales',
  'brand',
  'editorial',
  'education',
  'children',
  'training',
  'healthcare',
  'sustainability',
  'culture',
  'warm',
  'premium',
  'creative',
  'bold',
  'minimal-light',
  'minimal-dark',
  'monochrome',
  'custom-brand'
] as const

export const DOCUMENT_STYLE_MODES = ['auto', 'light', 'dark', 'print'] as const

export type VisualStyleId = (typeof VISUAL_STYLE_IDS)[number]
export type DocumentStyleMode = (typeof DOCUMENT_STYLE_MODES)[number]
export type ResolvedDocumentStyleMode = Exclude<DocumentStyleMode, 'auto'>
export type DocumentCompositionProfile = 'structured' | 'spatial' | 'kinetic'
export type DocumentStyleVariant =
  | 'classic'
  | 'formal'
  | 'technical'
  | 'editorial'
  | 'playful'
  | 'organic'
  | 'premium'
  | 'minimal'
  | 'bold'

export interface BrandThemeInput {
  name?: string
  primary_color?: string
  secondary_color?: string
  accent_color?: string
}

export interface DocumentStyleTone {
  base: string
  deep: string
  soft: string
  text: string
}

export interface ResolvedDocumentStyle {
  id: VisualStyleId
  label: string
  source: 'explicit' | 'brand' | 'reference' | 'inferred' | 'default'
  mode: ResolvedDocumentStyleMode
  composition: DocumentCompositionProfile
  variant: DocumentStyleVariant
  primary: string
  secondary: string
  accent: string
  deep: string
  soft: string
  background: string
  surface: string
  ink: string
  muted: string
  line: string
  onPrimary: string
  headingFont: string
  bodyFont: string
  eastAsiaFont: string
  tones: DocumentStyleTone[]
}

interface StyleSeed {
  label: string
  primary: string
  secondary: string
  accent: string
  variant: DocumentStyleVariant
  defaultMode?: ResolvedDocumentStyleMode
  headingFont?: string
  bodyFont?: string
  eastAsiaFont?: string
}

const STYLE_SEEDS: Record<VisualStyleId, StyleSeed> = {
  executive: {
    label: '高管商务',
    primary: '173B57',
    secondary: '2E6682',
    accent: 'C99A3D',
    variant: 'classic'
  },
  corporate: {
    label: '企业标准',
    primary: '225EA8',
    secondary: '3F7CAC',
    accent: '20A39E',
    variant: 'classic'
  },
  consulting: {
    label: '咨询策略',
    primary: '173F5F',
    secondary: '20639B',
    accent: '3CAEA3',
    variant: 'classic'
  },
  finance: {
    label: '金融投资',
    primary: '123B4A',
    secondary: '176B5B',
    accent: 'C6A15B',
    variant: 'formal'
  },
  government: {
    label: '政务正式',
    primary: '8C1D18',
    secondary: '17365D',
    accent: 'C9A227',
    variant: 'formal',
    eastAsiaFont: 'SimSun'
  },
  legal: {
    label: '法务合规',
    primary: '29323C',
    secondary: '566573',
    accent: '8B6F47',
    variant: 'formal',
    eastAsiaFont: 'SimSun'
  },
  academic: {
    label: '学术研究',
    primary: '5A2434',
    secondary: '274C77',
    accent: '8B5E3C',
    variant: 'formal',
    headingFont: 'Aptos Display',
    eastAsiaFont: 'SimSun'
  },
  research: {
    label: '研究白皮书',
    primary: '294C60',
    secondary: '4F6D7A',
    accent: 'C06C4D',
    variant: 'formal'
  },
  technology: {
    label: '科技未来',
    primary: '1167B1',
    secondary: '06BEE1',
    accent: '8B5CF6',
    variant: 'technical',
    defaultMode: 'dark'
  },
  product: {
    label: '产品设计',
    primary: '4F46E5',
    secondary: '0891B2',
    accent: 'F97316',
    variant: 'technical'
  },
  data: {
    label: '数据洞察',
    primary: '0F766E',
    secondary: '2563EB',
    accent: 'F59E0B',
    variant: 'technical'
  },
  startup: {
    label: '创业路演',
    primary: '6D28D9',
    secondary: 'DB2777',
    accent: 'F97316',
    variant: 'bold',
    defaultMode: 'dark'
  },
  sales: {
    label: '销售提案',
    primary: '1D4ED8',
    secondary: '0E7490',
    accent: 'EA580C',
    variant: 'classic'
  },
  brand: {
    label: '品牌营销',
    primary: 'BE185D',
    secondary: '7C3AED',
    accent: 'F59E0B',
    variant: 'bold'
  },
  editorial: {
    label: '编辑杂志',
    primary: '202020',
    secondary: 'B42318',
    accent: 'D4A72C',
    variant: 'editorial',
    headingFont: 'Georgia'
  },
  education: {
    label: '教育课程',
    primary: '2563EB',
    secondary: '0D9488',
    accent: 'F59E0B',
    variant: 'playful'
  },
  children: {
    label: '儿童教育',
    primary: 'F97360',
    secondary: '14B8A6',
    accent: 'F4B740',
    variant: 'playful'
  },
  training: {
    label: '培训工作坊',
    primary: '2563EB',
    secondary: '059669',
    accent: 'D97706',
    variant: 'playful'
  },
  healthcare: {
    label: '医疗健康',
    primary: '087E8B',
    secondary: '2563A6',
    accent: '5BBFBA',
    variant: 'organic'
  },
  sustainability: {
    label: '环保自然',
    primary: '2F855A',
    secondary: '2B6F77',
    accent: 'A3B341',
    variant: 'organic'
  },
  culture: {
    label: '文化人文',
    primary: '8F3B2F',
    secondary: '3F4A3C',
    accent: 'B88A44',
    variant: 'editorial',
    eastAsiaFont: 'SimSun'
  },
  warm: {
    label: '温暖生活',
    primary: 'C56A4A',
    secondary: 'B76E79',
    accent: 'D7A84B',
    variant: 'organic'
  },
  premium: {
    label: '高端品质',
    primary: '171717',
    secondary: '4B5563',
    accent: 'C6A15B',
    variant: 'premium',
    defaultMode: 'dark',
    headingFont: 'Georgia'
  },
  creative: {
    label: '创意作品',
    primary: 'C026D3',
    secondary: '0891B2',
    accent: 'F59E0B',
    variant: 'editorial'
  },
  bold: {
    label: '大胆发布',
    primary: 'DC2626',
    secondary: '111827',
    accent: 'FACC15',
    variant: 'bold'
  },
  'minimal-light': {
    label: '明亮极简',
    primary: '111827',
    secondary: '475569',
    accent: '2563EB',
    variant: 'minimal'
  },
  'minimal-dark': {
    label: '深色极简',
    primary: 'E2E8F0',
    secondary: '94A3B8',
    accent: '22D3EE',
    variant: 'minimal',
    defaultMode: 'dark'
  },
  monochrome: {
    label: '黑白印刷',
    primary: '111111',
    secondary: '555555',
    accent: '888888',
    variant: 'minimal',
    defaultMode: 'print'
  },
  'custom-brand': {
    label: '品牌自定义',
    primary: '225EA8',
    secondary: '3F7CAC',
    accent: '20A39E',
    variant: 'classic'
  }
}

const STYLE_RULES: Array<{ id: VisualStyleId; pattern: RegExp }> = [
  { id: 'children', pattern: /小学|幼儿|儿童|少儿|亲子|启蒙|家长会|child|kids?|primary school|kindergarten/i },
  { id: 'healthcare', pattern: /医疗|医院|健康|护理|医学|药品|临床|health|medical|hospital|clinical/i },
  { id: 'sustainability', pattern: /环保|生态|可持续|碳排|绿色发展|esg|sustainab|environment|climate/i },
  { id: 'government', pattern: /政府|政务|党建|政策|公共治理|工作报告|government|policy|public sector/i },
  { id: 'legal', pattern: /合同|法务|合规|审计|条款|制度|legal|contract|compliance|audit/i },
  { id: 'academic', pattern: /论文|答辩|学术|课题|文献|研究生|academic|thesis|dissertation|conference paper/i },
  { id: 'startup', pattern: /融资|创业|投资人|商业计划|pitch deck|fundrais|venture|startup/i },
  { id: 'finance', pattern: /金融|财务|财报|营收|利润|投资分析|finance|financial|revenue|profit/i },
  { id: 'data', pattern: /数据分析|经营分析|指标|看板|趋势|洞察|analytics|dashboard|data insight|metrics/i },
  { id: 'training', pattern: /培训|工作坊|操作课程|实训|演练|training|workshop|bootcamp/i },
  { id: 'education', pattern: /教育|课程|教学|课件|学习计划|education|course|teaching|lesson/i },
  { id: 'product', pattern: /产品方案|产品规划|功能规划|用户体验|交互设计|product|ux|feature plan/i },
  { id: 'sales', pattern: /销售|客户方案|售前|解决方案|sales|proposal|customer solution/i },
  { id: 'brand', pattern: /品牌|营销|传播|广告|campaign|branding|marketing/i },
  {
    id: 'technology',
    pattern: /人工智能|ai\b|软件|技术架构|云计算|算法|开发者|technology|technical|software|architecture/i
  },
  { id: 'premium', pattern: /高端|奢侈|豪华|精品|premium|luxury|exclusive/i },
  { id: 'culture', pattern: /文化|历史|艺术|博物馆|非遗|人文|culture|history|museum|heritage/i },
  { id: 'creative', pattern: /作品集|创意|设计提案|视觉设计|portfolio|creative|design showcase/i },
  { id: 'editorial', pattern: /杂志|专题|人物故事|出版|editorial|magazine|feature story/i },
  { id: 'warm', pattern: /家庭|生活方式|公益|关怀|陪伴|社区|lifestyle|family|community|charity/i },
  { id: 'research', pattern: /白皮书|行业研究|研究报告|调研报告|whitepaper|white paper|research report/i },
  { id: 'consulting', pattern: /战略|咨询|诊断|转型|组织变革|strategy|consulting|transformation/i },
  { id: 'executive', pattern: /高管|领导汇报|决策|年度总结|复盘|executive|leadership|board|annual review/i }
]

export const DOCUMENT_TYPE_SUGGESTIONS = {
  pptx: [
    'executive-report',
    'strategy-consulting',
    'operating-analysis',
    'investor-pitch',
    'product-launch',
    'product-plan',
    'technical-architecture',
    'sales-proposal',
    'brand-campaign',
    'annual-review',
    'project-retrospective',
    'training-course',
    'school-courseware',
    'children-education',
    'parent-meeting',
    'academic-defense',
    'conference-talk',
    'culture-feature',
    'event-keynote',
    'creative-portfolio'
  ],
  docx: [
    'business-report',
    'executive-memo',
    'project-proposal',
    'project-plan',
    'feasibility-study',
    'research-report',
    'academic-paper',
    'industry-whitepaper',
    'government-document',
    'policy-procedure',
    'meeting-minutes',
    'sop',
    'user-manual',
    'training-manual',
    'course-handout',
    'contract-agreement',
    'tender-document',
    'marketing-plan',
    'resume-portfolio',
    'newsletter'
  ],
  pdf: [
    'formal-report',
    'consulting-report',
    'annual-report',
    'research-whitepaper',
    'academic-publication',
    'policy-handbook',
    'brand-guideline',
    'brochure',
    'product-catalog',
    'lookbook-portfolio',
    'editorial-feature',
    'event-program',
    'training-material',
    'user-guide',
    'quick-start-guide',
    'data-brief',
    'infographic-report',
    'printable-workbook'
  ]
} as const

const DOCUMENT_TYPE_STYLE_HINTS: Record<string, VisualStyleId> = {
  'executive-report': 'executive',
  'strategy-consulting': 'consulting',
  'operating-analysis': 'data',
  'investor-pitch': 'startup',
  'product-launch': 'product',
  'product-plan': 'product',
  'technical-architecture': 'technology',
  'sales-proposal': 'sales',
  'brand-campaign': 'brand',
  'annual-review': 'executive',
  'project-retrospective': 'consulting',
  'training-course': 'training',
  'school-courseware': 'education',
  'children-education': 'children',
  'parent-meeting': 'education',
  'academic-defense': 'academic',
  'conference-talk': 'academic',
  'culture-feature': 'culture',
  'event-keynote': 'bold',
  'creative-portfolio': 'creative',
  'business-report': 'corporate',
  'executive-memo': 'executive',
  'project-proposal': 'consulting',
  'project-plan': 'corporate',
  'feasibility-study': 'research',
  'research-report': 'research',
  'academic-paper': 'academic',
  'industry-whitepaper': 'research',
  'government-document': 'government',
  'policy-procedure': 'legal',
  'meeting-minutes': 'corporate',
  sop: 'training',
  'user-manual': 'product',
  'training-manual': 'training',
  'course-handout': 'education',
  'contract-agreement': 'legal',
  'tender-document': 'government',
  'marketing-plan': 'brand',
  'resume-portfolio': 'creative',
  newsletter: 'editorial',
  'formal-report': 'corporate',
  'consulting-report': 'consulting',
  'annual-report': 'finance',
  'research-whitepaper': 'research',
  'academic-publication': 'academic',
  'policy-handbook': 'government',
  'brand-guideline': 'brand',
  brochure: 'brand',
  'product-catalog': 'product',
  'lookbook-portfolio': 'creative',
  'editorial-feature': 'editorial',
  'event-program': 'culture',
  'training-material': 'training',
  'user-guide': 'product',
  'quick-start-guide': 'product',
  'data-brief': 'data',
  'infographic-report': 'data',
  'printable-workbook': 'education'
}

const DOCUMENT_TYPE_COMPOSITION_HINTS: Record<string, DocumentCompositionProfile> = {
  'product-launch': 'kinetic',
  'investor-pitch': 'kinetic',
  'brand-campaign': 'kinetic',
  'event-keynote': 'kinetic',
  'conference-talk': 'kinetic',
  'event-program': 'kinetic',
  'creative-portfolio': 'spatial',
  'culture-feature': 'spatial',
  'resume-portfolio': 'spatial',
  'lookbook-portfolio': 'spatial',
  'editorial-feature': 'spatial',
  brochure: 'spatial',
  'product-catalog': 'spatial'
}

const STRUCTURED_COMPOSITION_PATTERN =
  /年度报告|研究报告|调研报告|工作报告|白皮书|分析报告|总结汇报|经营分析|策略|战略|规划|计划|治理|管理|复盘|评估|审计|研究|报告|高管|管理层|决策者|专业评审|董事会|report|analysis|strategy|planning|plan|research|review|management|governance|board|formal|white\s?paper/i
const KINETIC_COMPOSITION_PATTERN =
  /发布会|发布|艺术节|设计周|影像季|影像节|双年展|展览|开幕|盛典|峰会|路演|活动|战役|公共艺术|年轻观众|活力|沉浸|舞台|现场|campaign|launch|festival|biennale|exhibition|keynote|summit|roadshow|event|showcase|reveal|energetic|immersive/i
const SPATIAL_COMPOSITION_PATTERN =
  /建筑|空间|城市|场所|展陈|画廊|摄影|作品集|博物馆|图书馆|公园|景观|设计师|策展人|访客|审美|克制|architecture|spatial|urban|gallery|photography|portfolio|museum|library|landscape|curator/i

export function normalizeHexColor(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^#/, '').toUpperCase()
  return normalized && /^[0-9A-F]{6}$/.test(normalized) ? normalized : undefined
}

function mixHex(left: string, right: string, rightWeight: number): string {
  const weight = Math.max(0, Math.min(1, rightWeight))
  const mixChannel = (offset: number) => {
    const a = Number.parseInt(left.slice(offset, offset + 2), 16)
    const b = Number.parseInt(right.slice(offset, offset + 2), 16)
    return Math.round(a * (1 - weight) + b * weight)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase()
  }
  return `${mixChannel(0)}${mixChannel(2)}${mixChannel(4)}`
}

function contrastText(background: string): string {
  const channels = [0, 2, 4].map((offset) => Number.parseInt(background.slice(offset, offset + 2), 16) / 255)
  const luminance = channels[0] * 0.299 + channels[1] * 0.587 + channels[2] * 0.114
  return luminance > 0.62 ? '172033' : 'FFFFFF'
}

function tone(base: string, mode: ResolvedDocumentStyleMode, background: string): DocumentStyleTone {
  if (mode === 'dark') {
    return {
      base: mixHex(base, 'FFFFFF', 0.12),
      deep: mixHex(base, '000000', 0.3),
      soft: mixHex(background, base, 0.24),
      text: mixHex(base, 'FFFFFF', 0.42)
    }
  }

  return {
    base,
    deep: mixHex(base, '000000', 0.24),
    soft: mixHex(base, 'FFFFFF', 0.84),
    text: mixHex(base, '000000', 0.36)
  }
}

function requestedStyle(value: string | undefined): VisualStyleId | undefined {
  const normalized = value?.trim().toLowerCase()
  return VISUAL_STYLE_IDS.find((id) => id === normalized)
}

function inferStyle(documentType: string | undefined, title: string, content: string): VisualStyleId | undefined {
  const typeHint = DOCUMENT_TYPE_STYLE_HINTS[documentType?.trim().toLowerCase() || '']
  if (typeHint) return typeHint
  const heading = `${documentType || ''}\n${title}`
  const body = content.slice(0, 16000)
  const scored = STYLE_RULES.map((rule) => {
    const flags = `${rule.pattern.flags.replace(/g/g, '')}g`
    const titleMatches = [...heading.matchAll(new RegExp(rule.pattern.source, flags))].length
    const bodyMatches = [...body.matchAll(new RegExp(rule.pattern.source, flags))].length
    return { id: rule.id, titleMatches, bodyMatches, score: titleMatches * 5 + Math.min(bodyMatches, 4) }
  }).sort((left, right) => right.score - left.score)
  const winner = scored[0]
  return winner && (winner.titleMatches > 0 || winner.bodyMatches >= 2) ? winner.id : undefined
}

function inferCompositionProfile(
  documentType: string | undefined,
  title: string,
  content: string,
  styleId: VisualStyleId
): DocumentCompositionProfile {
  const normalizedType = documentType?.trim().toLowerCase() || ''
  const typeHint = DOCUMENT_TYPE_COMPOSITION_HINTS[normalizedType]
  if (typeHint) return typeHint

  const heading = `${documentType || ''}\n${title}`
  if (STRUCTURED_COMPOSITION_PATTERN.test(heading)) return 'structured'
  if (KINETIC_COMPOSITION_PATTERN.test(heading)) return 'kinetic'
  if (SPATIAL_COMPOSITION_PATTERN.test(heading)) return 'spatial'

  const body = content.slice(0, 12000)
  const scores: Record<DocumentCompositionProfile, number> = {
    structured: [...body.matchAll(new RegExp(STRUCTURED_COMPOSITION_PATTERN.source, 'gi'))].length,
    spatial: [...body.matchAll(new RegExp(SPATIAL_COMPOSITION_PATTERN.source, 'gi'))].length,
    kinetic: [...body.matchAll(new RegExp(KINETIC_COMPOSITION_PATTERN.source, 'gi'))].length
  }
  const bodyWinner = (Object.entries(scores) as Array<[DocumentCompositionProfile, number]>).sort(
    (left, right) => right[1] - left[1]
  )[0]
  if (bodyWinner[1] >= 2) return bodyWinner[0]
  if (body.length >= 2400 || body.split(/\r?\n/).filter(Boolean).length >= 18) return 'structured'

  if (['startup', 'brand', 'creative', 'bold'].includes(styleId)) return 'kinetic'
  if (['editorial', 'culture', 'healthcare', 'sustainability', 'warm', 'premium'].includes(styleId)) {
    return 'spatial'
  }
  return 'structured'
}

export function resolveDocumentStyle(input: {
  visualStyle?: string
  styleMode?: DocumentStyleMode
  documentType?: string
  title: string
  content: string
  format: 'docx' | 'pptx' | 'pdf'
  brandTheme?: BrandThemeInput
}): ResolvedDocumentStyle {
  const explicit = requestedStyle(input.visualStyle)
  const hasBrandColors = Boolean(
    normalizeHexColor(input.brandTheme?.primary_color) ||
      normalizeHexColor(input.brandTheme?.secondary_color) ||
      normalizeHexColor(input.brandTheme?.accent_color)
  )
  const inferred = inferStyle(input.documentType, input.title, input.content)
  const id = explicit ?? (hasBrandColors ? 'custom-brand' : inferred) ?? 'corporate'
  const source: ResolvedDocumentStyle['source'] = explicit
    ? 'explicit'
    : hasBrandColors
      ? 'brand'
      : inferred
        ? 'inferred'
        : 'default'
  const seed = STYLE_SEEDS[id]
  const composition = inferCompositionProfile(input.documentType, input.title, input.content, id)
  const primary = normalizeHexColor(input.brandTheme?.primary_color) ?? seed.primary
  const secondary = normalizeHexColor(input.brandTheme?.secondary_color) ?? seed.secondary
  const accent = normalizeHexColor(input.brandTheme?.accent_color) ?? seed.accent
  const requestedMode = input.styleMode && input.styleMode !== 'auto' ? input.styleMode : seed.defaultMode || 'light'
  const mode = input.format === 'docx' && requestedMode === 'dark' ? 'light' : requestedMode
  const dark = mode === 'dark'
  const print = mode === 'print'
  const background = dark ? '0B1120' : 'F8FAFC'
  const surface = dark ? '172033' : 'FFFFFF'
  const ink = dark ? 'F8FAFC' : print ? '111111' : '172033'
  const muted = dark ? 'CBD5E1' : print ? '555555' : '64748B'
  const line = dark ? '334155' : print ? 'B8B8B8' : mixHex(primary, 'FFFFFF', 0.72)

  return {
    id,
    label: seed.label,
    source,
    mode,
    composition,
    variant: seed.variant,
    primary: print ? '222222' : primary,
    secondary: print ? '555555' : secondary,
    accent: print ? '888888' : accent,
    deep: dark ? mixHex(primary, '000000', 0.5) : mixHex(primary, '000000', 0.28),
    soft: dark ? mixHex(primary, background, 0.68) : mixHex(primary, 'FFFFFF', 0.86),
    background,
    surface,
    ink,
    muted,
    line,
    onPrimary: contrastText(print ? '222222' : primary),
    headingFont: seed.headingFont || 'Aptos Display',
    bodyFont: seed.bodyFont || 'Aptos',
    eastAsiaFont: seed.eastAsiaFont || 'Microsoft YaHei',
    tones: [
      tone(print ? '222222' : primary, mode, background),
      tone(print ? '555555' : secondary, mode, background),
      tone(print ? '888888' : accent, mode, background)
    ]
  }
}

export function defaultDocumentStyle(format: 'docx' | 'pptx' | 'pdf'): ResolvedDocumentStyle {
  return resolveDocumentStyle({ title: '', content: '', format, visualStyle: 'corporate' })
}
