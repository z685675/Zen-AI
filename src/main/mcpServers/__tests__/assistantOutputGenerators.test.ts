import fs from 'node:fs'
import path from 'node:path'

import AdmZip from 'adm-zip'
import { PDFDocument } from 'pdf-lib'
import { PDFParse } from 'pdf-parse'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('node:child_process')
vi.unmock('node:os')
vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() })
  }
}))
vi.mock('@main/utils', () => ({ toAsarUnpackedPath: (value: string) => value }))
vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    getVersion: () => 'test',
    getName: () => 'Zen AI',
    getLocale: () => 'zh-CN',
    isPackaged: false
  }
}))

import { createPdfBuffer, createPptxBuffer } from '../assistant'
import { resolveDocumentStyle } from '../assistantDocumentStyles'
import { createDocxBuffer } from '../assistantDocx'
import { verifyGeneratedOutput } from '../assistantOutputValidation'
import { createXlsxBuffer, type WorkbookInput } from '../assistantXlsx'

describe('assistant output generators', () => {
  it('embeds the same normalized image contract into DOCX, PPTX, and PDF output', async () => {
    const officeRenderMode = process.env.ZEN_AI_OFFICE_RENDER_SMOKE === '1' ? 'required' : 'skip'
    const image = await sharp({
      create: { width: 640, height: 360, channels: 4, background: { r: 24, g: 96, b: 180, alpha: 1 } }
    })
      .png()
      .toBuffer()
    const assets = new Map([
      [
        'hero',
        {
          id: 'hero',
          sourcePath: 'hero.png',
          data: image,
          width: 640,
          height: 360,
          altText: 'Blue product preview'
        }
      ]
    ])

    const docx = await createDocxBuffer('Media report', '# Media report\n\n![Product preview](asset:hero)', [], assets)
    const docxVerification = await verifyGeneratedOutput({
      format: 'docx',
      buffer: docx,
      expectedMediaAssets: 1,
      renderValidation: officeRenderMode
    })
    const docxZip = new AdmZip(docx)
    expect(docxZip.getEntries().some((entry) => entry.entryName.startsWith('word/media/'))).toBe(true)
    expect(docxZip.readAsText('word/document.xml')).toContain('<a:blip r:embed=')
    expect(docxVerification.checks).toContain('embedded-media')

    const pptx = await createPptxBuffer(
      [
        {
          title: 'Product evidence',
          subtitle: 'A real embedded image',
          layout: 'image',
          accent: 'blue',
          bullets: ['Visible media', 'Bounded layout'],
          imageAssetId: 'hero'
        }
      ],
      assets
    )
    const pptxVerification = await verifyGeneratedOutput({
      format: 'pptx',
      buffer: pptx,
      expectedSlides: 1,
      expectedMediaAssets: 1,
      renderValidation: officeRenderMode
    })
    const pptxZip = new AdmZip(pptx)
    expect(pptxZip.getEntries().some((entry) => entry.entryName.startsWith('ppt/media/image'))).toBe(true)
    expect(pptxZip.readAsText('ppt/slides/slide1.xml')).toContain('<p:pic>')
    expect(pptxZip.readAsText('ppt/slides/slide1.xml')).toContain('Blue product preview')
    expect(pptxZip.readAsText('ppt/slides/_rels/slide1.xml.rels')).toContain('/relationships/image"')
    expect(pptxVerification.checks).toContain('embedded-media')
    if (officeRenderMode === 'required') {
      expect(docxVerification.details.render_verification).toBe('passed')
      expect(pptxVerification.details.render_verification).toBe('passed')
    }

    const pdf = await createPdfBuffer('Media report', '![Product preview](asset:hero)', assets)
    const pdfVerification = await verifyGeneratedOutput({ format: 'pdf', buffer: pdf, expectedMediaAssets: 1 })
    expect(pdf.toString('latin1')).toContain('/Subtype /Image')
    expect(pdfVerification.checks).toContain('embedded-media')
    expect(pdfVerification.checks).toContain('pdf-rendered-pages')
    expect(pdfVerification.details.render_verification).toBe('passed')
    expect(pdfVerification.details.minimum_page_ink_ratio).toBeGreaterThan(0.01)
  })

  it('converts Markdown into native Word structure without appending the source again', async () => {
    const content = `# Acceptance Report

**Audience:** Product reviewers

## Results

1. **Runtime** completes the task.
2. Status converges once.

- Keep the result traceable.

| Item | Status |
| --- | --- |
    | PPT | Passed |
| DOCX | Passed |`
    const buffer = await createDocxBuffer('Acceptance Report', content, [])
    const verification = await verifyGeneratedOutput({ format: 'docx', buffer })
    const zip = new AdmZip(buffer)
    const documentXml = zip.readAsText('word/document.xml')

    expect(documentXml.match(/Acceptance Report/g)).toHaveLength(1)
    expect(documentXml.match(/Runtime/g)).toHaveLength(1)
    expect(documentXml).toContain('<w:pStyle w:val="Heading2"')
    expect(documentXml).toContain('<w:b/>')
    expect(documentXml).toContain('<w:numPr>')
    expect(documentXml.match(/<w:tbl>/g)).toHaveLength(1)
    expect(documentXml).not.toContain('# Acceptance Report')
    expect(documentXml).not.toContain('**Audience:**')
    expect(documentXml).not.toContain('| --- | --- |')
    expect(verification.checks).toContain('ooxml-relationships')
  })

  it('renders Markdown links as visible native Word hyperlinks', async () => {
    const buffer = await createDocxBuffer(
      'Research Report',
      '## Sources\n\n1. [OpenAI ChatGPT Plans](https://openai.com/chatgpt/pricing/)',
      []
    )
    const zip = new AdmZip(buffer)
    const documentXml = zip.readAsText('word/document.xml')
    const relationshipsXml = zip.readAsText('word/_rels/document.xml.rels')

    expect(documentXml).toContain('<w:hyperlink ')
    expect(documentXml).toContain('r:id="')
    expect(documentXml).toContain('<w:rStyle w:val="Hyperlink"/>')
    expect(relationshipsXml).toContain('Target="https://openai.com/chatgpt/pricing/"')
    expect(relationshipsXml).toContain('TargetMode="External"')
  })

  it('creates a standards-complete PPTX package without repair-prone notes parts', async () => {
    const buffer = await createPptxBuffer([
      {
        title: 'Zen AI Flagship',
        subtitle: 'Product launch',
        layout: 'cover',
        accent: 'blue',
        bullets: ['Reliable files', 'Mature layouts']
      },
      {
        title: 'Three product pillars',
        layout: 'cards',
        accent: 'green',
        takeaway: 'The assistant completes work rather than only answering questions.',
        bullets: ['Create deliverables', 'Run recurring work', 'Use specialized Skills']
      },
      {
        title: 'Next step',
        layout: 'summary',
        accent: 'amber',
        bullets: ['Validate', 'Ship']
      }
    ])
    const verification = await verifyGeneratedOutput({ format: 'pptx', buffer, expectedSlides: 3 })
    const zip = new AdmZip(buffer)
    const names = zip.getEntries().map((entry) => entry.entryName)
    const nameSet = new Set(names)

    expect(names.some((name) => name.startsWith('ppt/notesMasters/'))).toBe(false)
    expect(names.some((name) => name.startsWith('ppt/notesSlides/'))).toBe(false)
    expect(verification.details.slides).toBe(3)
    expect(zip.readAsText('ppt/presentation.xml')).not.toContain('notesMasterIdLst')
    expect(zip.readAsText('ppt/presentation.xml')).toContain('<p:sldSz cx="9144000" cy="5143500"')
    expect(zip.readAsText('docProps/app.xml')).toContain('<Notes>0</Notes>')

    for (let index = 1; index <= 3; index++) {
      const relationships = zip.readAsText(`ppt/slides/_rels/slide${index}.xml.rels`)
      expect(relationships).toContain('/relationships/slideLayout"')
      expect(relationships).not.toContain('/relationships/notesSlide"')
    }
    expect(zip.readAsText('ppt/slideLayouts/_rels/slideLayout1.xml.rels')).toContain('/relationships/slideMaster"')
    expect(zip.readAsText('ppt/slideMasters/slideMaster1.xml')).toContain('<p:txStyles>')
    expect(zip.readAsText('ppt/slides/slide1.xml')).toContain('Zen AI Flagship')

    const theme = zip.readAsText('ppt/theme/theme1.xml')
    const majorFont = theme.match(/<a:majorFont>[\s\S]*?<\/a:majorFont>/)?.[0] || ''
    const minorFont = theme.match(/<a:minorFont>[\s\S]*?<\/a:minorFont>/)?.[0] || ''
    for (const fontCollection of [majorFont, minorFont]) {
      expect(fontCollection).toContain('<a:latin ')
      expect(fontCollection).toContain('<a:ea ')
      expect(fontCollection).toContain('<a:cs ')
    }
    expect(
      countThemeStyles(theme, 'fillStyleLst', /<a:(?:solidFill|gradFill|pattFill|blipFill)\b/g)
    ).toBeGreaterThanOrEqual(3)
    expect(countThemeStyles(theme, 'lnStyleLst', /<a:ln\b/g)).toBeGreaterThanOrEqual(3)
    expect(countThemeStyles(theme, 'effectStyleLst', /<a:effectStyle\b/g)).toBeGreaterThanOrEqual(3)
    expect(
      countThemeStyles(theme, 'bgFillStyleLst', /<a:(?:solidFill|gradFill|pattFill|blipFill)\b/g)
    ).toBeGreaterThanOrEqual(3)

    for (const relationshipPart of names.filter((name) => name.endsWith('.rels'))) {
      const source = relationshipSource(relationshipPart)
      const xml = zip.readAsText(relationshipPart)
      for (const relationship of xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)) {
        const attributes = relationship[1]
        if (/\bTargetMode="External"/.test(attributes)) continue
        const target = attributes.match(/\bTarget="([^"]+)"/)?.[1]
        if (!target) continue
        const resolved = target.startsWith('/')
          ? path.posix.normalize(target.slice(1))
          : path.posix.normalize(path.posix.join(path.posix.dirname(source), target))
        expect(nameSet.has(resolved), `${relationshipPart} targets missing ${resolved}`).toBe(true)
      }
    }

    const contentTypes = zip.readAsText('[Content_Types].xml')
    for (const override of contentTypes.matchAll(/<Override\b[^>]*\bPartName="\/([^"]+)"[^>]*\/?\s*>/g)) {
      expect(nameSet.has(override[1]), `content type targets missing ${override[1]}`).toBe(true)
    }
  })

  it('keeps dense metric and timeline content inside bounded presentation layouts', async () => {
    const buffer = await createPptxBuffer([
      {
        title: '四区与四档计费，让不同节奏的人都能找到位置',
        layout: 'metric',
        accent: 'coral',
        takeaway: '空间分区解决彼此打扰，套餐分层降低首次进入门槛。',
        bullets: [
          '空间分区：安静区、交流区、会议包间、休息区，先解决不同状态的互相打扰',
          '价格阶梯：单次体验到周卡、月卡、夜间卡，再到包间与机构套餐',
          '管理原则：规则前置、按区匹配服务，让用户一进门就知道如何使用'
        ]
      },
      {
        title: '12 个月路线图：先验证单店模型，再复制合作网络',
        layout: 'timeline',
        accent: 'green',
        takeaway: '前 2 个月验证需求，3 到 6 个月跑通合作，之后再做复制决策。',
        bullets: [
          'M1—M2｜试运营 4—8 周：验证深夜客流、分区规则、门禁与卫生排班',
          'M3—M4｜优化产品：调整价格带、预约机制与夜间卡，形成首版经营看板',
          'M5—M6｜建立合作：联动高校、医院、社区与创业园，测试团体套餐',
          'M7—M9｜产品化复制：沉淀 SOP、排班、安保、隐私与消防清单',
          'M10—M12｜扩店决策：仅在指标达标时复制，否则优化首店模型'
        ]
      }
    ])
    const zip = new AdmZip(buffer)
    const metricXml = zip.readAsText('ppt/slides/slide1.xml')
    const timelineXml = zip.readAsText('ppt/slides/slide2.xml')

    expect(metricXml).toContain('Technical module heading 1')
    expect(metricXml).toContain('Technical module detail 1')
    expect(metricXml).not.toContain('Metric value 1')
    expect(metricXml).not.toContain('Translate this number into a decision')
    expect(metricXml).toContain('先解决不同状态的互相打扰')
    expect(timelineXml).toContain('timeline detail row 1')
    expect(timelineXml).toContain('timeline period 1')
    expect(timelineXml).not.toContain('Timeline card 1')
    expect(timelineXml).toContain('验证深夜客流、分区规则、门禁与卫生排班')

    const observedScales: number[] = []
    for (const xml of [metricXml, timelineXml]) {
      const textBoxCount = xml.match(/<p:txBody>/g)?.length || 0
      const autoFitCount = xml.match(/<a:normAutofit\b[^>]*\/>/g)?.length || 0
      expect(textBoxCount).toBeGreaterThan(0)
      expect(autoFitCount).toBe(textBoxCount)
      expect(xml).not.toContain('vertOverflow="ellipsis"')
      expect(xml).toMatch(/<a:normAutofit fontScale="\d+" lnSpcReduction="\d+"\/>/)
      observedScales.push(
        ...[...xml.matchAll(/<a:normAutofit\b[^>]*fontScale="(\d+)"/g)].map((match) => Number(match[1]))
      )

      const shapeIds = [...xml.matchAll(/<p:cNvPr\s+id="(\d+)"/g)].map((match) => match[1])
      expect(new Set(shapeIds).size).toBe(shapeIds.length)
      for (const match of xml.matchAll(
        /<a:xfrm><a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(-?\d+)" cy="(-?\d+)"\/><\/a:xfrm>/g
      )) {
        const [, rawX, rawY, rawWidth, rawHeight] = match
        const [x, y, width, height] = [rawX, rawY, rawWidth, rawHeight].map(Number)
        expect(x).toBeGreaterThanOrEqual(0)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(width).toBeGreaterThan(0)
        expect(height).toBeGreaterThan(0)
        expect(x + width).toBeLessThanOrEqual(9_144_000)
        expect(y + height).toBeLessThanOrEqual(5_143_500)
      }
    }
    expect(observedScales.every((scale) => scale >= 65_000 && scale <= 100_000)).toBe(true)
  })

  it('records a conservative font scale instead of hiding the end of dense text', async () => {
    const buffer = await createPptxBuffer([
      {
        title: 'Dense presentation title '.repeat(3).trim(),
        layout: 'cover',
        accent: 'blue',
        bullets: ['Capacity-aware typography']
      }
    ])
    const xml = new AdmZip(buffer).readAsText('ppt/slides/slide1.xml')
    const scales = [...xml.matchAll(/<a:normAutofit\b[^>]*fontScale="(\d+)"/g)].map((match) => Number(match[1]))

    expect(scales.some((scale) => scale < 100_000)).toBe(true)
    expect(scales.every((scale) => scale >= 65_000 && scale <= 100_000)).toBe(true)
    expect(xml).not.toContain('vertOverflow="ellipsis"')
  })

  it('renders shared style semantics differently across PPTX, DOCX, and PDF', async () => {
    const consulting = resolveDocumentStyle({
      visualStyle: 'consulting',
      title: '城市更新战略',
      content: '',
      format: 'pptx'
    })
    const children = resolveDocumentStyle({
      visualStyle: 'children',
      title: '城市更新战略',
      content: '',
      format: 'pptx'
    })
    const slides = [
      {
        title: '城市更新战略',
        subtitle: '从公共空间到社区活力',
        visual: 'internal design direction not visible',
        layout: 'cover' as const,
        accent: 'blue' as const,
        accentExplicit: false,
        bullets: ['洞察', '行动', '评估']
      }
    ]
    const consultingPptx = new AdmZip(await createPptxBuffer(slides, new Map(), consulting))
    const childrenPptx = new AdmZip(await createPptxBuffer(slides, new Map(), children))
    const consultingSlide = consultingPptx.readAsText('ppt/slides/slide1.xml')
    const childrenSlide = childrenPptx.readAsText('ppt/slides/slide1.xml')

    expect(consultingSlide).toContain('Consulting cover index')
    expect(consultingSlide).toContain('Consulting cover divider')
    expect(consultingSlide).toContain('173F5F')
    expect(childrenSlide).toContain('Playful orbit large')
    expect(childrenSlide).toContain('Playful orbit accent')
    expect(childrenSlide).toContain('F97360')
    expect(childrenSlide).not.toBe(consultingSlide)
    expect(consultingSlide).not.toContain('internal design direction not visible')
    expect(childrenSlide).not.toContain('internal design direction not visible')

    const childrenDocxStyle = resolveDocumentStyle({
      visualStyle: 'children',
      title: '家庭阅读手册',
      content: '',
      format: 'docx'
    })
    const docx = new AdmZip(
      await createDocxBuffer(
        '家庭阅读手册',
        '# 家庭阅读手册\n\n> 每天一起读十五分钟。\n\n| 环节 | 建议 |\n| --- | --- |\n| 共读 | 轮流提问 |',
        [],
        new Map(),
        childrenDocxStyle
      )
    )
    const stylesXml = docx.readAsText('word/styles.xml')
    const documentXml = docx.readAsText('word/document.xml')
    expect(stylesXml).toContain('ZenAiDocumentTitle')
    expect(stylesXml).toContain('F97360')
    expect(documentXml).toContain('w:fill="F97360"')
    expect(documentXml).toContain('w:color="F4B740"')

    const pdfContent = '# 城市更新战略\n\n## 核心判断\n\n- 公共空间连接社区生活。\n\n> 设计应服务于真实使用。'
    const editorialPdf = await createPdfBuffer(
      '城市更新战略',
      pdfContent,
      new Map(),
      resolveDocumentStyle({ visualStyle: 'editorial', title: '城市更新战略', content: pdfContent, format: 'pdf' })
    )
    const technologyPdf = await createPdfBuffer(
      '城市更新战略',
      pdfContent,
      new Map(),
      resolveDocumentStyle({
        visualStyle: 'technology',
        styleMode: 'dark',
        title: '城市更新战略',
        content: pdfContent,
        format: 'pdf'
      })
    )
    const editorialParser = new PDFParse({ data: editorialPdf })
    const technologyParser = new PDFParse({ data: technologyPdf })
    try {
      const editorialText = await editorialParser.getText()
      const editorialShot = await editorialParser.getScreenshot({
        partial: [1],
        desiredWidth: 480,
        imageBuffer: true,
        imageDataUrl: false
      })
      const technologyText = await technologyParser.getText()
      const technologyShot = await technologyParser.getScreenshot({
        partial: [1],
        desiredWidth: 480,
        imageBuffer: true,
        imageDataUrl: false
      })
      expect(editorialText.text).toContain('城市更新战略')
      expect(technologyText.text).toContain('城市更新战略')
      const editorialStats = await sharp(Buffer.from(editorialShot.pages[0].data)).stats()
      const technologyStats = await sharp(Buffer.from(technologyShot.pages[0].data)).stats()
      const editorialBrightness =
        editorialStats.channels.slice(0, 3).reduce((sum, channel) => sum + channel.mean, 0) / 3
      const technologyBrightness =
        technologyStats.channels.slice(0, 3).reduce((sum, channel) => sum + channel.mean, 0) / 3
      expect(editorialBrightness).toBeGreaterThan(technologyBrightness + 80)
    } finally {
      await editorialParser.destroy()
      await technologyParser.destroy()
    }
  })

  it('changes PPTX composition language rather than only recoloring one layout skeleton', async () => {
    const slides = [
      {
        title: '夜航书房增长方案',
        subtitle: '从空间服务到稳定复购',
        takeaway: '用清晰的内容结构验证不同视觉语言。',
        layout: 'cover' as const,
        accent: 'blue' as const,
        accentExplicit: false,
        bullets: ['洞察', '方案', '行动']
      },
      {
        title: '三项增长抓手',
        takeaway: '先建立主次关系，再组织并列信息。',
        layout: 'cards' as const,
        accent: 'blue' as const,
        accentExplicit: false,
        bullets: ['场景：覆盖夜间刚需', '会员：建立稳定复购', '合作：连接周边机构']
      },
      {
        title: '关键经营信号',
        takeaway: '数字必须对应明确的经营判断。',
        layout: 'metric' as const,
        accent: 'blue' as const,
        accentExplicit: false,
        bullets: [
          '夜间上座率：72% | 高峰时段需求稳定',
          '会员复购率：48% | 月卡具备增长空间',
          '用户推荐率：81% | 口碑是主要获客渠道'
        ]
      },
      {
        title: '核心判断',
        takeaway: '用户购买的不是座位，而是一段可持续专注的时间。',
        layout: 'insight' as const,
        accent: 'blue' as const,
        accentExplicit: false,
        bullets: ['深夜供给仍然稀缺', '安静规则需要被看见', '服务体验决定复购']
      }
    ]
    const cases = [
      {
        style: 'corporate',
        markers: ['Corporate cover folio', 'Narrative lead field', 'Editorial metric value 1', 'Primary statement']
      },
      {
        style: 'consulting',
        markers: ['Consulting cover index', 'Editorial number 1', 'Editorial metric value 1', 'Primary statement']
      },
      {
        style: 'technology',
        markers: ['Technical frame', 'Technical module 1', 'Data metric value 1', 'Technical insight frame']
      },
      {
        style: 'children',
        markers: ['Playful orbit large', 'Staggered idea 1', 'Metric orbit 1', 'Organic statement halo']
      },
      {
        style: 'premium',
        markers: ['Premium rule top', 'Editorial number 1', 'Editorial metric value 1', 'Primary statement']
      },
      {
        style: 'bold',
        markers: ['Bold color field', 'Bold idea field 1', 'Metric color field 1', 'Bold statement canvas']
      }
    ] as const

    const compositions: string[] = []
    for (const testCase of cases) {
      const style = resolveDocumentStyle({
        visualStyle: testCase.style,
        title: slides[0].title,
        content: slides.flatMap((slide) => slide.bullets).join('\n'),
        format: 'pptx'
      })
      const zip = new AdmZip(await createPptxBuffer(slides, new Map(), style))
      const slideXml = slides.map((_, slideIndex) => zip.readAsText(`ppt/slides/slide${slideIndex + 1}.xml`))
      compositions.push(slideXml.join('\n'))

      testCase.markers.forEach((marker, slideIndex) => expect(slideXml[slideIndex]).toContain(marker))
      for (const xml of slideXml) {
        const shapeIds = [...xml.matchAll(/<p:cNvPr\s+id="(\d+)"/g)].map((match) => match[1])
        expect(new Set(shapeIds).size).toBe(shapeIds.length)
        for (const match of xml.matchAll(
          /<a:xfrm><a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(-?\d+)" cy="(-?\d+)"\/><\/a:xfrm>/g
        )) {
          const [x, y, width, height] = match.slice(1).map(Number)
          expect(x).toBeGreaterThanOrEqual(0)
          expect(y).toBeGreaterThanOrEqual(0)
          expect(width).toBeGreaterThan(0)
          expect(height).toBeGreaterThan(0)
          expect(x + width).toBeLessThanOrEqual(9_144_000)
          expect(y + height).toBeLessThanOrEqual(5_143_500)
        }
      }
    }

    expect(new Set(compositions).size).toBe(cases.length)
  })

  it('keeps every PPTX layout language structurally safe across the core slide types', async () => {
    const styles = [
      'corporate',
      'executive',
      'consulting',
      'government',
      'technology',
      'product',
      'data',
      'bold',
      'brand',
      'editorial',
      'children',
      'healthcare',
      'premium',
      'minimal-light'
    ] as const
    const slides = [
      {
        title: '城市夜间服务计划',
        subtitle: '面向个人用户的连续服务',
        layout: 'cover' as const,
        bullets: ['洞察', '方案', '行动']
      },
      { title: '第一部分：需求与机会', subtitle: '从真实场景开始', layout: 'section' as const, bullets: [] },
      {
        title: '本次汇报回答四个问题',
        layout: 'agenda' as const,
        bullets: ['为什么现在', '用户需要什么', '方案如何运行', '下一步怎么做']
      },
      {
        title: '三项核心能力形成完整体验',
        takeaway: '主次关系比平均分配更重要。',
        layout: 'cards' as const,
        bullets: ['发现：识别高频需求', '执行：完成连续任务', '复盘：沉淀个人偏好']
      },
      {
        title: '用户需要的是持续结果',
        takeaway: '一次回答不是完整服务。',
        layout: 'insight' as const,
        bullets: ['任务需要跨步骤推进', '文件结果需要真实可用', '过程状态需要持续透明']
      },
      {
        title: '从零散操作转向完整交付',
        layout: 'comparison' as const,
        bullets: [
          '当前：需要反复切换工具',
          '当前：结果散落在多个位置',
          '目标：一个入口连续推进',
          '目标：文件和状态统一交付'
        ]
      },
      {
        title: '四步完成一次任务',
        takeaway: '每一步都有明确输入与产出。',
        layout: 'process' as const,
        bullets: ['理解目标', '规划步骤', '执行工具', '校验交付']
      },
      {
        title: '十二个月逐步验证',
        takeaway: '先验证价值，再扩大范围。',
        layout: 'timeline' as const,
        bullets: [
          'Q1 | 原型：验证个人高频场景',
          'Q2 | 完善：补齐文件和状态能力',
          'Q3 | 扩展：增加更多专业 Skill',
          'Q4 | 复盘：评估下一阶段投入'
        ]
      },
      {
        title: '三个指标判断是否有效',
        takeaway: '数字必须能够支持决策。',
        layout: 'metric' as const,
        bullets: [
          '任务完成率：82% | 核心闭环已建立',
          '文件可用率：93% | 交付质量稳定',
          '重复使用率：61% | 用户价值可持续'
        ]
      },
      {
        title: '关键指标保持增长',
        takeaway: '趋势比单点数字更有解释力。',
        layout: 'chart' as const,
        bullets: ['第一季度：42', '第二季度：58', '第三季度：73', '第四季度：86']
      },
      {
        title: '用户反馈',
        subtitle: '首轮测试用户',
        takeaway: '我需要的不是更多按钮，而是任务真的做完。',
        layout: 'quote' as const,
        bullets: []
      },
      {
        title: 'Product experience in context',
        subtitle: 'The visual should lead while annotations remain readable.',
        layout: 'image' as const,
        bullets: ['Show the real state', 'Explain the important detail', 'Keep a clear reading order'],
        imageAssetId: 'layout-reference'
      },
      {
        title: '下一阶段聚焦三个动作',
        takeaway: '保持范围清晰，持续验证质量。',
        layout: 'summary' as const,
        bullets: ['完成核心回归测试', '补齐真实场景样本', '根据反馈迭代布局']
      }
    ].map((slide) => ({ ...slide, accent: 'blue' as const, accentExplicit: false }))

    const referenceImage = await sharp({
      create: { width: 1200, height: 760, channels: 4, background: { r: 28, g: 94, b: 132, alpha: 1 } }
    })
      .png()
      .toBuffer()
    const assets = new Map([
      [
        'layout-reference',
        {
          id: 'layout-reference',
          sourcePath: 'layout-reference.png',
          data: referenceImage,
          width: 1200,
          height: 760,
          altText: 'Layout language reference image'
        }
      ]
    ])
    const signatures = {
      corporate: ['Process node 1', 'Timeline open line', 'Chart bar 1', 'Classic image ledger'],
      executive: [
        'executive process signature rail',
        'executive timeline signature rail',
        'executive chart row 1',
        'Executive image evidence rail'
      ],
      consulting: [
        'consulting process signature rail',
        'consulting timeline signature rail',
        'consulting chart rank 1',
        'Consulting image panorama'
      ],
      government: [
        'formal process signature rail',
        'formal timeline signature rail',
        'formal chart row 1',
        'Formal image plate'
      ],
      technology: ['Step circle 1', 'Timeline dot 1', 'Instrument signal 1', 'Technical image telemetry'],
      product: [
        'Product process focus 1',
        'Product timeline focus 1',
        'Product chart focus 1',
        'Product image annotation rail'
      ],
      data: ['Step circle 1', 'Timeline dot 1', 'Instrument signal 1', 'Data image source panel'],
      bold: ['bold process color field 1', 'bold timeline color field 1', 'bold chart field 1', 'Bold image manifesto'],
      brand: [
        'brand process color field 1',
        'brand timeline color field 1',
        'brand chart field 1',
        'Brand image canvas'
      ],
      editorial: [
        'editorial process signature rail',
        'editorial timeline signature rail',
        'editorial chart rank 1',
        'Editorial image spread'
      ],
      children: [
        'playful process curved path',
        'playful timeline curved path',
        'playful chart bubble 1',
        'Playful image activity lane'
      ],
      healthcare: [
        'organic process curved path',
        'organic timeline curved path',
        'organic chart bubble 1',
        'Organic image narrative band'
      ],
      premium: [
        'premium process signature rail',
        'premium timeline signature rail',
        'premium chart rank 1',
        'Premium image gallery'
      ],
      'minimal-light': [
        'minimal process signature rail',
        'minimal timeline signature rail',
        'minimal chart rank 1',
        'Minimal image plane'
      ]
    } as const

    for (const styleId of styles) {
      const style = resolveDocumentStyle({ visualStyle: styleId, title: slides[0].title, content: '', format: 'pptx' })
      const zip = new AdmZip(await createPptxBuffer(slides, assets, style))
      const [processMarker, timelineMarker, chartMarker, imageMarker] = signatures[styleId]
      expect(zip.readAsText('ppt/slides/slide7.xml')).toContain(processMarker)
      expect(zip.readAsText('ppt/slides/slide8.xml')).toContain(timelineMarker)
      expect(zip.readAsText('ppt/slides/slide10.xml')).toContain(chartMarker)
      const imageXml = zip.readAsText('ppt/slides/slide12.xml')
      expect(imageXml).toContain(imageMarker)
      expect(imageXml).toContain('<p:pic>')
      expect(imageXml.indexOf(imageMarker)).toBeLessThan(imageXml.indexOf('<p:pic>'))
      for (let slideIndex = 0; slideIndex < slides.length; slideIndex++) {
        const xml = zip.readAsText(`ppt/slides/slide${slideIndex + 1}.xml`)
        const textBoxCount = xml.match(/<p:txBody>/g)?.length || 0
        const autoFitCount = xml.match(/<a:normAutofit\b[^>]*\/>/g)?.length || 0
        expect(autoFitCount).toBe(textBoxCount)
        expect(xml).not.toContain('vertOverflow="ellipsis"')

        const shapeIds = [...xml.matchAll(/<p:cNvPr\s+id="(\d+)"/g)].map((match) => match[1])
        expect(new Set(shapeIds).size).toBe(shapeIds.length)
        for (const match of xml.matchAll(
          /<a:xfrm><a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(-?\d+)" cy="(-?\d+)"\/><\/a:xfrm>/g
        )) {
          const [x, y, width, height] = match.slice(1).map(Number)
          expect(x).toBeGreaterThanOrEqual(0)
          expect(y).toBeGreaterThanOrEqual(0)
          expect(width).toBeGreaterThan(0)
          expect(height).toBeGreaterThan(0)
          expect(x + width).toBeLessThanOrEqual(9_144_000)
          expect(y + height).toBeLessThanOrEqual(5_143_500)
        }
      }
    }
  })

  it('changes PPTX geometry when the same visual style has a different composition profile', async () => {
    const slides = [
      {
        title: '城市影像计划',
        subtitle: '同一编辑风格，不同场合',
        takeaway: '构图应由任务语境决定。',
        layout: 'cover' as const,
        accent: 'blue' as const,
        accentExplicit: false,
        bullets: ['主题', '场合', '体验']
      },
      {
        title: '内容必须形成清晰判断',
        takeaway: '结论先行，证据随后。',
        layout: 'insight' as const,
        accent: 'blue' as const,
        accentExplicit: false,
        bullets: ['受众需要快速理解核心主张', '事实用于支持判断', '行动承接最终结论']
      }
    ]
    const structuredStyle = resolveDocumentStyle({
      visualStyle: 'editorial',
      title: '城市影像年度研究报告',
      content: '面向管理层和专业评审。',
      format: 'pptx'
    })
    const kineticStyle = resolveDocumentStyle({
      visualStyle: 'editorial',
      title: '城市影像节开幕发布',
      content: '面向年轻观众的现场活动。',
      format: 'pptx'
    })

    const structuredZip = new AdmZip(await createPptxBuffer(slides, new Map(), structuredStyle))
    const kineticZip = new AdmZip(await createPptxBuffer(slides, new Map(), kineticStyle))
    const structuredCover = structuredZip.readAsText('ppt/slides/slide1.xml')
    const kineticCover = kineticZip.readAsText('ppt/slides/slide1.xml')

    expect(structuredStyle.composition).toBe('structured')
    expect(kineticStyle.composition).toBe('kinetic')
    expect(structuredCover).toContain('Editorial marker')
    expect(structuredCover).not.toContain('Kinetic cover stage')
    expect(kineticCover).toContain('Kinetic cover stage')
    expect(kineticCover).not.toBe(structuredCover)
    expect(structuredZip.readAsText('ppt/slides/slide2.xml')).toContain('Statement spine')
    expect(kineticZip.readAsText('ppt/slides/slide2.xml')).toContain('Kinetic insight statement field')
  })

  it('renders complex semantic PPTX layouts with bounded shapes and autofit text', async () => {
    const slides = [
      {
        title: '六类角色共同构成支持网络',
        takeaway: '中心机制负责连接各方。',
        layout: 'network' as const,
        bullets: [
          '学校 | 识别早期需求',
          '家庭 | 提供日常支持',
          '社区 | 承接持续活动',
          '医院 | 提供专业干预',
          '平台 | 连接服务资源',
          '公益组织 | 覆盖弱势群体'
        ]
      },
      {
        title: '四象限决定资源投入顺序',
        takeaway: '影响力与实施难度共同决定优先级。',
        layout: 'matrix' as const,
        bullets: [
          '高影响低难度 | 立即推进',
          '高影响高难度 | 分阶段攻坚',
          '低影响低难度 | 顺手优化',
          '低影响高难度 | 暂缓投入'
        ]
      },
      {
        title: '一天的活动按节奏逐步展开',
        takeaway: '内容密度在上午和下午之间保持平衡。',
        layout: 'schedule' as const,
        bullets: [
          '09:00 | 签到：建立现场氛围',
          '09:30 | 开场：说明共同目标',
          '10:00 | 分享：呈现关键洞察',
          '11:00 | 讨论：形成初步共识',
          '14:00 | 共创：完成行动方案',
          '16:00 | 收束：确认后续责任'
        ]
      },
      {
        title: '体验路线从发现问题走向持续行动',
        takeaway: '每个站点都推动一次认知或行为变化。',
        layout: 'route' as const,
        bullets: [
          '看见 | 发现：理解真实处境',
          '倾听 | 共情：进入人物故事',
          '探索 | 学习：掌握支持方法',
          '选择 | 决策：找到合适行动',
          '连接 | 协作：匹配服务资源',
          '持续 | 复访：记录长期变化'
        ]
      }
    ].map((slide) => ({ ...slide, accent: 'blue' as const, accentExplicit: false }))
    const style = resolveDocumentStyle({
      visualStyle: 'brand',
      title: '城市支持网络体验节',
      content: '面向公众的沉浸式活动。',
      format: 'pptx'
    })
    const zip = new AdmZip(await createPptxBuffer(slides, new Map(), style))
    const markers = ['Network hub', 'Matrix quadrant 1', 'Schedule time field 1', 'Route path outbound']

    markers.forEach((marker, slideIndex) => {
      const xml = zip.readAsText(`ppt/slides/slide${slideIndex + 1}.xml`)
      expect(xml).toContain(marker)
      const textBoxCount = xml.match(/<p:txBody>/g)?.length || 0
      expect(xml.match(/<a:normAutofit\b[^>]*\/>/g)?.length || 0).toBe(textBoxCount)
      expect(xml).not.toContain('vertOverflow="ellipsis"')
      const shapeIds = [...xml.matchAll(/<p:cNvPr\s+id="(\d+)"/g)].map((match) => match[1])
      expect(new Set(shapeIds).size).toBe(shapeIds.length)
      for (const match of xml.matchAll(
        /<a:xfrm><a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(-?\d+)" cy="(-?\d+)"\/><\/a:xfrm>/g
      )) {
        const [x, y, width, height] = match.slice(1).map(Number)
        expect(x).toBeGreaterThanOrEqual(0)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(width).toBeGreaterThan(0)
        expect(height).toBeGreaterThan(0)
        expect(x + width).toBeLessThanOrEqual(9_144_000)
        expect(y + height).toBeLessThanOrEqual(5_143_500)
      }
    })
  })

  it('creates an advanced workbook with formulas, formatting, and a chart', async () => {
    const templatePath = path.join(
      process.cwd(),
      'resources/skills/xlsx/assets/workbook-templates/assistant-acceptance.json'
    )
    const template = JSON.parse(fs.readFileSync(templatePath, 'utf8')) as {
      title: string
      workbook: WorkbookInput
    }
    const buffer = createXlsxBuffer(template.workbook, [], template.title)
    const verification = await verifyGeneratedOutput({ format: 'xlsx', buffer })
    const zip = new AdmZip(buffer)
    const names = zip.getEntries().map((entry) => entry.entryName)

    expect(names).toContain('xl/worksheets/sheet1.xml')
    expect(names).toContain('xl/worksheets/sheet2.xml')
    expect(names).toContain('xl/charts/chart1.xml')
    expect(zip.readAsText('xl/worksheets/sheet2.xml')).toContain('<f>COUNTIF(')
    expect(zip.readAsText('xl/worksheets/sheet1.xml')).toContain('<autoFilter')
    expect(zip.readAsText('xl/charts/chart1.xml')).toContain('<c:dLblPos val="outEnd"/>')
    expect(zip.readAsText('xl/charts/chart1.xml')).toContain('<c:showVal val="1"/>')
    expect(verification.checks).toContain('ooxml-content-types')
  })

  it('suppresses value labels on dense workbook charts', () => {
    const categories = Array.from({ length: 12 }, (_, index) => `2025-${String(index + 1).padStart(2, '0')}`)
    const monthly = Array.from({ length: 12 }, (_, index) => 230_000 + index * 10_000)
    const cumulative = monthly.map((_, index) => monthly.slice(0, index + 1).reduce((total, value) => total + value, 0))
    const workbook: WorkbookInput = {
      sheets: [
        {
          name: '经营看板',
          rows: [
            ['月份', '月度收入', '累计收入'],
            ...categories.map((month, index) => [month, monthly[index], cumulative[index]])
          ],
          charts: [
            {
              type: 'column',
              title: '月度收入与累计收入趋势',
              series: [
                { name: '月度收入', categories, values: monthly },
                { name: '累计收入', categories, values: cumulative }
              ]
            }
          ]
        }
      ]
    }

    const zip = new AdmZip(createXlsxBuffer(workbook, [], '经营分析'))
    const chartXml = zip.readAsText('xl/charts/chart1.xml')
    expect(chartXml).not.toContain('<c:dLbls>')
    expect(chartXml).not.toContain('<c:showVal val="1"/>')
  })

  it('creates a line chart with visible variation for nonzero trend data', () => {
    const categories = ['2025-01', '2025-02', '2025-03', '2025-04']
    const workbook: WorkbookInput = {
      sheets: [
        {
          name: '经营看板',
          rows: [
            ['月份', '朝阳店', '海淀店'],
            ['2025-01', 128_600, 112_500],
            ['2025-02', 121_400, 108_900],
            ['2025-03', 136_800, 119_700],
            ['2025-04', 142_500, 124_200]
          ],
          charts: [
            {
              type: 'line',
              title: '两家门店月度收入趋势',
              series: [
                { name: '朝阳店', categories, values: [128_600, 121_400, 136_800, 142_500] },
                { name: '海淀店', categories, values: [112_500, 108_900, 119_700, 124_200] }
              ]
            }
          ]
        }
      ]
    }

    const zip = new AdmZip(createXlsxBuffer(workbook, [], '收入趋势'))
    const chartXml = zip.readAsText('xl/charts/chart1.xml')
    expect(chartXml).toContain('<c:lineChart>')
    expect(chartXml).toContain('<c:symbol val="circle"/>')
    expect(chartXml).not.toContain('<c:min val="0"/>')
  })

  it('rejects stale SUMIFS caches when a display label is used as the criterion', () => {
    const workbook: WorkbookInput = {
      sheets: [
        {
          name: '原始数据',
          rows: [
            ['月份', '门店', '收入'],
            ['2025-01', '朝阳店', 128_600]
          ]
        },
        {
          name: '经营看板',
          rows: [
            ['月份', '朝阳店收入'],
            [
              '2025-01',
              {
                formula: "SUMIFS('原始数据'!$C$2:$C$2,'原始数据'!$A$2:$A$2,$A2,'原始数据'!$B$2:$B$2,B$1)",
                result: 128_600
              }
            ]
          ]
        }
      ]
    }

    expect(() => createXlsxBuffer(workbook, [], '错误趋势')).toThrow(
      /Formula cached result mismatch.*'经营看板'!B2.*expected 0.*received 128600/
    )
  })

  it('keeps a valid all-zero line chart without assuming the business meaning', () => {
    const workbook: WorkbookInput = {
      sheets: [
        {
          name: '经营看板',
          rows: [
            ['月份', '朝阳店'],
            ['2025-01', 0],
            ['2025-02', 0]
          ],
          charts: [
            {
              type: 'line',
              title: '收入趋势',
              series: [{ name: '朝阳店', categories: ['2025-01', '2025-02'], values: [0, 0] }]
            }
          ]
        }
      ]
    }

    const zip = new AdmZip(createXlsxBuffer(workbook, [], '零值趋势'))
    const chartXml = zip.readAsText('xl/charts/chart1.xml')
    expect(chartXml).toContain('<c:min val="-1"/>')
    expect(chartXml).toContain('<c:max val="1"/>')
  })

  it('creates a readable axis for negative trend values', () => {
    const workbook: WorkbookInput = {
      sheets: [
        {
          name: '现金流',
          rows: [
            ['月份', '净现金流'],
            ['2025-01', -50],
            ['2025-02', -40]
          ],
          charts: [
            {
              type: 'line',
              title: '净现金流趋势',
              series: [{ name: '净现金流', categories: ['2025-01', '2025-02'], values: [-50, -40] }]
            }
          ]
        }
      ]
    }

    const zip = new AdmZip(createXlsxBuffer(workbook, [], '负值趋势'))
    const chartXml = zip.readAsText('xl/charts/chart1.xml')
    expect(chartXml).toContain('<c:min val="-55"/>')
    expect(chartXml).toContain('<c:max val="-35"/>')
  })

  it('rejects direct and indirect circular workbook formulas before writing XLSX', () => {
    const directCycle: WorkbookInput = {
      sheets: [
        {
          name: '看板',
          rows: [
            ['月份', '收入'],
            ['2025-01', { formula: 'SUMIFS(原始数据!C:C,原始数据!A:A,A2,原始数据!B:B,B2)', result: 10 }]
          ]
        },
        {
          name: '原始数据',
          rows: [
            ['月份', '门店', '收入'],
            ['2025-01', '朝阳店', 10]
          ]
        }
      ]
    }
    const indirectCycle: WorkbookInput = {
      sheets: [
        {
          name: '汇总',
          rows: [
            ['A', 'B'],
            [
              { formula: 'B2+1', result: 2 },
              { formula: 'A2+1', result: 2 }
            ]
          ]
        }
      ]
    }

    expect(() => createXlsxBuffer(directCycle, [], 'Direct cycle')).toThrow(/Circular formula reference.*'看板'!B2/)
    expect(() => createXlsxBuffer(indirectCycle, [], 'Indirect cycle')).toThrow(
      /Circular formula reference.*'汇总'!A2.*'汇总'!B2/
    )
  })

  it('creates a searchable multipage Chinese PDF with a continued table', async () => {
    const rows = Array.from(
      { length: 36 },
      (_, index) =>
        `| P${String(index + 1).padStart(2, '0')} | 中文文件质量检查 | 验证字体、分页和表格边界 | ${index % 5 === 0 ? 'P1' : '通过'} |`
    ).join('\n')
    const content = `# 测试范围
验证 Zen AI 中文 PDF 的字体、分页和表格。

## 核心结论
- 中文必须完整显示。
- 表格跨页不能截断。

## 验收明细
| 编号 | 测试项 | 结果说明 | 状态 |
| --- | --- | --- | --- |
${rows}`
    const buffer = await createPdfBuffer('Zen AI Auto Runtime 验收摘要', content)
    const verification = await verifyGeneratedOutput({ format: 'pdf', buffer })
    const document = await PDFDocument.load(buffer)

    expect(buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(document.getPageCount()).toBeGreaterThanOrEqual(2)
    expect(buffer.length).toBeGreaterThan(10_000)
    expect(verification.details.pages).toBeGreaterThanOrEqual(2)
  })

  it('renders common Markdown blocks into PDF without repeating the document title', async () => {
    const title = '交付质量摘要'
    const content = `# 交付质量摘要

1. 验证文件结构
2. 检查可读性

> 生成成功不等于交付成功。

**结论：**需要完成校验。

\`\`\`text
status: passed
\`\`\``
    const buffer = await createPdfBuffer(title, content)
    const parser = new PDFParse({ data: buffer })
    try {
      const result = await parser.getText()
      expect(result.text.match(/交付质量摘要/g)).toHaveLength(1)
      expect(result.text).toContain('1.')
      expect(result.text).toContain('生成成功不等于交付成功')
      expect(result.text).toContain('status: passed')
      expect(result.text).not.toContain('**')
      expect(result.text).not.toContain('```')
    } finally {
      await parser.destroy()
    }
  })

  it('rejects an unclosed Markdown fence at the delivery boundary', async () => {
    await expect(
      verifyGeneratedOutput({
        format: 'md',
        buffer: Buffer.from('# Example\n\n```ts\nconst value = 1\n', 'utf8')
      })
    ).rejects.toThrow(/unclosed code fence/)
  })

  it('rejects a structurally valid PDF whose rendered page is blank', async () => {
    const document = await PDFDocument.create()
    document.addPage([320, 240])
    await expect(
      verifyGeneratedOutput({ format: 'pdf', buffer: Buffer.from(await document.save()), renderValidation: 'required' })
    ).rejects.toThrow(/appears blank/)
  })
})

function countThemeStyles(xml: string, listName: string, itemPattern: RegExp): number {
  const list = xml.match(new RegExp(`<a:${listName}[^>]*>([\\s\\S]*?)</a:${listName}>`))?.[1] || ''
  return list.match(itemPattern)?.length || 0
}

function relationshipSource(relationshipsPath: string): string {
  if (relationshipsPath === '_rels/.rels') return ''
  const [prefix, leaf] = relationshipsPath.split('/_rels/')
  return path.posix.join(prefix, leaf.replace(/\.rels$/, ''))
}
