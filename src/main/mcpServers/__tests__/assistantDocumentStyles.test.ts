import { describe, expect, it } from 'vitest'

import { resolveDocumentStyle, VISUAL_STYLE_IDS } from '../assistantDocumentStyles'

describe('assistant document styles', () => {
  it('offers a broad shared catalog without collapsing everything into business blue', () => {
    expect(VISUAL_STYLE_IDS).toHaveLength(29)
    expect(VISUAL_STYLE_IDS).toEqual(
      expect.arrayContaining([
        'executive',
        'academic',
        'technology',
        'children',
        'healthcare',
        'culture',
        'editorial',
        'premium',
        'minimal-dark',
        'monochrome'
      ])
    )
  })

  it('infers a children style from a simple Chinese education request', () => {
    const style = resolveDocumentStyle({
      title: '小学家庭教育指南',
      content: '面向家长和儿童的亲子学习活动。',
      format: 'docx'
    })

    expect(style.id).toBe('children')
    expect(style.source).toBe('inferred')
    expect(style.variant).toBe('playful')
    expect(style.mode).toBe('light')
  })

  it('lets an explicit visual style win over topic inference', () => {
    const style = resolveDocumentStyle({
      visualStyle: 'editorial',
      title: '人工智能技术架构',
      content: '云计算、算法与软件系统。',
      format: 'pptx'
    })

    expect(style.id).toBe('editorial')
    expect(style.source).toBe('explicit')
    expect(style.variant).toBe('editorial')
  })

  it('uses the document archetype before a competing topic keyword', () => {
    const style = resolveDocumentStyle({
      documentType: 'investor-pitch',
      title: 'AI 平台融资路演',
      content: '人工智能技术架构与产品能力。',
      format: 'pptx'
    })

    expect(style.id).toBe('startup')
    expect(style.source).toBe('inferred')
    expect(style.variant).toBe('bold')
  })

  it('does not let one incidental body keyword restyle an entire document', () => {
    const style = resolveDocumentStyle({
      title: '空间服务年度路线图',
      content: '联动高校、医院、社区与创业园，建立跨机构合作。',
      format: 'pptx'
    })

    expect(style.id).toBe('corporate')
    expect(style.source).toBe('default')
  })

  it('applies brand colors while preserving a selected layout language', () => {
    const style = resolveDocumentStyle({
      visualStyle: 'consulting',
      title: '品牌战略',
      content: '',
      format: 'pdf',
      brandTheme: {
        name: 'Zen AI',
        primary_color: '#FFCC00',
        secondary_color: '123456',
        accent_color: '#00AA88'
      }
    })

    expect(style.id).toBe('consulting')
    expect(style.source).toBe('explicit')
    expect(style.variant).toBe('classic')
    expect(style.primary).toBe('FFCC00')
    expect(style.secondary).toBe('123456')
    expect(style.accent).toBe('00AA88')
    expect(style.onPrimary).toBe('172033')
  })

  it('creates distinct dark-mode tones instead of reusing pale light cards', () => {
    const style = resolveDocumentStyle({
      visualStyle: 'technology',
      styleMode: 'dark',
      title: 'AI 平台',
      content: '',
      format: 'pptx'
    })

    expect(style.mode).toBe('dark')
    expect(new Set(style.tones.map((tone) => tone.soft)).size).toBe(3)
    expect(style.tones.every((tone) => tone.soft !== 'FFFFFF')).toBe(true)
    expect(style.tones.every((tone) => tone.text !== '172033')).toBe(true)
  })

  it('keeps Word light and editable even for a dark-first style family', () => {
    const style = resolveDocumentStyle({
      visualStyle: 'premium',
      styleMode: 'dark',
      title: '高端品牌手册',
      content: '',
      format: 'docx'
    })

    expect(style.mode).toBe('light')
    expect(style.background).toBe('F8FAFC')
    expect(style.ink).toBe('172033')
  })

  it('uses a kinetic composition for an art festival instead of treating culture as a formal report', () => {
    const style = resolveDocumentStyle({
      title: '城市公共艺术双年展发布会',
      content: '面向年轻观众，以现场体验和跨城联动形成传播事件。',
      format: 'pptx'
    })

    expect(style.id).toBe('culture')
    expect(style.composition).toBe('kinetic')
  })

  it('keeps a formal cultural annual report structured', () => {
    const style = resolveDocumentStyle({
      title: '国家公园文化遗产年度研究报告',
      content: '面向管理层与专业评审，汇报年度监测结果和治理建议。',
      format: 'pptx'
    })

    expect(style.composition).toBe('structured')
  })

  it('recognizes the occasion in a mixed technology and sustainability topic', () => {
    const style = resolveDocumentStyle({
      title: '海洋科技与生态影像季',
      content: '以沉浸式影像、海洋传感技术和公众活动连接科学与自然。',
      format: 'pptx'
    })

    expect(style.composition).toBe('kinetic')
  })

  it('preserves an explicit visual style while deriving composition from context', () => {
    const style = resolveDocumentStyle({
      visualStyle: 'editorial',
      title: '城市影像节开幕发布',
      content: '面向观众的现场主题演讲。',
      format: 'pptx'
    })

    expect(style.id).toBe('editorial')
    expect(style.source).toBe('explicit')
    expect(style.composition).toBe('kinetic')
  })
})
