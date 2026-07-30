import AdmZip from 'adm-zip'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('node:path')
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

import { createPptxBuffer } from '../assistant'
import { resolveDocumentStyle } from '../assistantDocumentStyles'
import { verifyGeneratedOutput } from '../assistantOutputValidation'
import { createPptxFromTemplate, profilePptxTemplateSlides, rewriteTemplateChartXml } from '../assistantPptxTemplate'

async function createTemplateDeck() {
  const style = resolveDocumentStyle({
    visualStyle: 'children',
    title: '自然探索课程',
    content: '观察、实验与分享',
    format: 'pptx'
  })
  return await createPptxBuffer(
    [
      {
        title: '自然探索课程',
        subtitle: '让好奇心带路',
        layout: 'cover',
        accent: 'coral',
        bullets: ['观察', '实验', '分享']
      },
      {
        title: '课程由三个环节组成',
        takeaway: '每个环节都产生可见成果',
        layout: 'cards',
        accent: 'green',
        bullets: ['观察: 记录细节', '实验: 验证猜想', '分享: 表达发现']
      },
      {
        title: '从一次周末活动开始',
        layout: 'summary',
        accent: 'amber',
        bullets: ['确定主题', '准备材料', '完成复盘']
      }
    ],
    new Map(),
    style
  )
}

async function createMultiMasterTemplateDeck() {
  const zip = new AdmZip(await createTemplateDeck())
  const duplicatePart = (source: string, target: string, transform: (value: string) => string = (value) => value) => {
    const value = zip.readAsText(source)
    if (!value) throw new Error(`Missing fixture part: ${source}`)
    zip.addFile(target, Buffer.from(transform(value), 'utf-8'))
  }

  duplicatePart('ppt/slideMasters/slideMaster1.xml', 'ppt/slideMasters/slideMaster2.xml')
  duplicatePart(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    'ppt/slideMasters/_rels/slideMaster2.xml.rels',
    (value) => value.replace(/slideLayout1\.xml/g, 'slideLayout2.xml')
  )
  duplicatePart('ppt/slideLayouts/slideLayout1.xml', 'ppt/slideLayouts/slideLayout2.xml')
  duplicatePart(
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    'ppt/slideLayouts/_rels/slideLayout2.xml.rels',
    (value) => value.replace(/slideMaster1\.xml/g, 'slideMaster2.xml')
  )

  const contentTypes = zip.readAsText('[Content_Types].xml')
  zip.updateFile(
    '[Content_Types].xml',
    Buffer.from(
      contentTypes.replace(
        '</Types>',
        '<Override PartName="/ppt/slideMasters/slideMaster2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/></Types>'
      ),
      'utf-8'
    )
  )

  const presentationRelationships = zip.readAsText('ppt/_rels/presentation.xml.rels')
  const masterRelationship = presentationRelationships.match(
    /<Relationship\b(?=[^>]*Target="slideMasters\/slideMaster1\.xml")[^>]*(?:\/>|>\s*<\/Relationship>)/
  )?.[0]
  if (!masterRelationship) throw new Error('Fixture presentation is missing its master relationship')
  zip.updateFile(
    'ppt/_rels/presentation.xml.rels',
    Buffer.from(
      presentationRelationships.replace(
        '</Relationships>',
        `${masterRelationship.replace(/Id="[^"]+"/, 'Id="rId999"').replace('slideMaster1.xml', 'slideMaster2.xml')}</Relationships>`
      ),
      'utf-8'
    )
  )

  const presentation = zip.readAsText('ppt/presentation.xml')
  zip.updateFile(
    'ppt/presentation.xml',
    Buffer.from(
      presentation.replace('</p:sldMasterIdLst>', '<p:sldMasterId id="2147483649" r:id="rId999"/></p:sldMasterIdLst>'),
      'utf-8'
    )
  )

  const slideThreeRelationships = zip.readAsText('ppt/slides/_rels/slide3.xml.rels')
  zip.updateFile(
    'ppt/slides/_rels/slide3.xml.rels',
    Buffer.from(slideThreeRelationships.replace(/slideLayout1\.xml/g, 'slideLayout2.xml'), 'utf-8')
  )
  return zip.toBuffer()
}

function applyStandardPlaceholder(source: string, shapeName: string, placeholderType: string, genericName: string) {
  const pattern = new RegExp(`<p:nvSpPr><p:cNvPr(?=[^>]*name="${shapeName}")[^>]*/>[\\s\\S]*?</p:nvSpPr>`)
  const shape = source.match(pattern)?.[0]
  if (!shape) throw new Error(`Missing fixture shape: ${shapeName}`)
  const updatedShape = shape
    .replace(`name="${shapeName}"`, `name="${genericName}"`)
    .replace('<p:nvPr/>', `<p:nvPr><p:ph type="${placeholderType}"/></p:nvPr>`)
  return source.replace(shape, updatedShape)
}

describe('native PPTX template reuse', () => {
  it('removes ellipsis overflow from text boxes that receive replacement copy', async () => {
    const sourceZip = new AdmZip(await createTemplateDeck())
    const slideXml = sourceZip.readAsText('ppt/slides/slide1.xml')
    sourceZip.updateFile(
      'ppt/slides/slide1.xml',
      Buffer.from(
        slideXml.replace(/(<p:cNvPr\b[^>]*\bname="Title"[\s\S]*?<a:bodyPr) /, '$1 vertOverflow="ellipsis" '),
        'utf-8'
      )
    )
    const generated = await createPptxFromTemplate(sourceZip.toBuffer(), 'reference.pptx', [], {
      file_path: 'reference.pptx',
      mode: 'edit-copy',
      shape_replacements: [{ slide_number: 1, shape_name: 'Title', text: 'Updated title without truncation' }]
    })

    const outputXml = new AdmZip(generated.buffer).readAsText('ppt/slides/slide1.xml')
    expect(outputXml).toContain('Updated title without truncation')
    expect(outputXml).not.toContain('vertOverflow="ellipsis"')
    expect(outputXml).toContain('<a:normAutofit')
  })

  it('edits selected pages in a copy while preserving all unedited slide parts', async () => {
    const source = await createTemplateDeck()
    const sourceSnapshot = Buffer.from(source)
    const original = new AdmZip(source)
    const generated = await createPptxFromTemplate(
      source,
      'reference.pptx',
      [
        {
          title: '社区课程由三个共创环节组成',
          takeaway: '居民从参与者变成共同设计者',
          bullets: ['走访: 收集需求', '工作坊: 共同设计', '行动日: 完成落地'],
          targetSlideNumber: 2
        }
      ],
      { file_path: 'reference.pptx', mode: 'edit-copy' }
    )
    const output = new AdmZip(generated.buffer)

    expect(source).toEqual(sourceSnapshot)
    expect(output.readFile('ppt/slides/slide1.xml')).toEqual(original.readFile('ppt/slides/slide1.xml'))
    expect(output.readFile('ppt/slides/slide3.xml')).toEqual(original.readFile('ppt/slides/slide3.xml'))
    expect(output.readAsText('ppt/slides/slide2.xml')).toContain('社区课程由三个共创环节组成')
    expect(output.readAsText('ppt/slides/slide2.xml')).not.toContain('课程由三个环节组成')
    expect(generated.summary).toEqual(
      expect.objectContaining({
        mode: 'edit-copy',
        sourceSlides: 3,
        outputSlides: 3,
        editedSlides: [2],
        exactPackageReuse: true
      })
    )

    const verification = await verifyGeneratedOutput({
      format: 'pptx',
      buffer: generated.buffer,
      expectedSlides: 3,
      renderValidation: 'skip'
    })
    expect(verification.passed).toBe(true)
  })

  it('builds a new slide list while preserving native masters, layouts, theme, and relationships', async () => {
    const source = await createTemplateDeck()
    const original = new AdmZip(source)
    const generated = await createPptxFromTemplate(
      source,
      'reference.pptx',
      [
        {
          title: '城市微更新共创计划',
          subtitle: '让街角空间重新连接居民',
          bullets: ['走访社区', '共同设计', '持续维护'],
          templateSlideNumber: 1
        },
        {
          title: '三步把意见变成行动',
          takeaway: '每一步都有居民参与和成果回传',
          bullets: ['发现: 标记问题', '共创: 形成方案', '行动: 完成改造'],
          templateSlideNumber: 2
        }
      ],
      { file_path: 'reference.pptx', mode: 'new-deck' }
    )
    const output = new AdmZip(generated.buffer)
    const slideParts = output
      .getEntries()
      .map((entry) => entry.entryName)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))

    expect(slideParts).toHaveLength(2)
    expect(output.readAsText('ppt/slides/slide1.xml')).toContain('城市微更新共创计划')
    expect(output.readAsText('ppt/slides/slide2.xml')).toContain('三步把意见变成行动')
    expect(output.readAsText('ppt/presentation.xml').match(/<p:sldId\b/g)).toHaveLength(2)
    expect(output.readFile('ppt/slideMasters/slideMaster1.xml')).toEqual(
      original.readFile('ppt/slideMasters/slideMaster1.xml')
    )
    expect(output.readFile('ppt/slideLayouts/slideLayout1.xml')).toEqual(
      original.readFile('ppt/slideLayouts/slideLayout1.xml')
    )
    expect(generated.summary).toEqual(
      expect.objectContaining({
        mode: 'new-deck',
        sourceSlides: 3,
        outputSlides: 2,
        templateSlides: [1, 2],
        mastersPreserved: 1,
        exactPackageReuse: true
      })
    )

    for (let index = 1; index <= 2; index++) {
      const relationships = output.readAsText(`ppt/slides/_rels/slide${index}.xml.rels`)
      expect(relationships.match(/\/slideLayout"/g)).toHaveLength(1)
      expect(relationships).not.toContain('/notesSlide"')
    }

    const verification = await verifyGeneratedOutput({
      format: 'pptx',
      buffer: generated.buffer,
      expectedSlides: 2,
      renderValidation: 'skip'
    })
    expect(verification.passed).toBe(true)
  })

  it('supports exact named-shape text replacement without rewriting unrelated pages', async () => {
    const source = await createTemplateDeck()
    const original = new AdmZip(source)
    const generated = await createPptxFromTemplate(source, 'reference.pptx', [], {
      file_path: 'reference.pptx',
      mode: 'edit-copy',
      shape_replacements: [{ slide_number: 1, shape_name: 'Title', text: '替换后的模板标题' }]
    })
    const output = new AdmZip(generated.buffer)

    expect(output.readAsText('ppt/slides/slide1.xml')).toContain('替换后的模板标题')
    expect(output.readFile('ppt/slides/slide2.xml')).toEqual(original.readFile('ppt/slides/slide2.xml'))
    expect(output.readFile('ppt/slides/slide3.xml')).toEqual(original.readFile('ppt/slides/slide3.xml'))
  })

  it('can reuse the same native source slide multiple times without coupling the generated pages', async () => {
    const source = await createTemplateDeck()
    const generated = await createPptxFromTemplate(
      source,
      'reference.pptx',
      [
        { title: 'First reused layout', bullets: ['First body'], templateSlideNumber: 2 },
        { title: 'Second reused layout', bullets: ['Second body'], templateSlideNumber: 2 },
        { title: 'Third reused layout', bullets: ['Third body'], templateSlideNumber: 2 }
      ],
      { file_path: 'reference.pptx', mode: 'new-deck' }
    )
    const output = new AdmZip(generated.buffer)

    expect(output.readAsText('ppt/slides/slide1.xml')).toContain('First reused layout')
    expect(output.readAsText('ppt/slides/slide2.xml')).toContain('Second reused layout')
    expect(output.readAsText('ppt/slides/slide3.xml')).toContain('Third reused layout')
    expect(generated.summary.templateSlides).toEqual([2])
    expect(generated.summary.outputSlides).toBe(3)
    expect(output.readAsText('ppt/slides/_rels/slide1.xml.rels')).toBe(
      output.readAsText('ppt/slides/_rels/slide2.xml.rels')
    )
  })

  it('clones selected source pages without rewriting their slide XML', async () => {
    const source = await createTemplateDeck()
    const original = new AdmZip(source)
    const generated = await createPptxFromTemplate(
      source,
      'reference.pptx',
      [
        { title: 'Ignored clone title', bullets: [], templateSlideNumber: 1, preserveContent: true },
        { title: 'Ignored clone title', bullets: [], templateSlideNumber: 3, preserveContent: true }
      ],
      { file_path: 'reference.pptx', mode: 'new-deck' }
    )
    const output = new AdmZip(generated.buffer)

    expect(output.readFile('ppt/slides/slide1.xml')).toEqual(original.readFile('ppt/slides/slide1.xml'))
    expect(output.readFile('ppt/slides/slide2.xml')).toEqual(original.readFile('ppt/slides/slide3.xml'))
    expect(generated.summary.editedSlides).toEqual([])
    expect(generated.summary.clonedSlides).toEqual([1, 2])
    expect(generated.summary.templateSlides).toEqual([1, 3])

    await expect(
      createPptxFromTemplate(
        source,
        'reference.pptx',
        [{ title: 'Conflicting clone', bullets: [], templateSlideNumber: 1, preserveContent: true }],
        {
          file_path: 'reference.pptx',
          mode: 'new-deck',
          shape_replacements: [{ slide_number: 1, shape_name: 'Title', text: 'Must not edit an exact clone' }]
        }
      )
    ).rejects.toThrow(/preserve_content cannot be combined/i)
  })

  it('preserves and reuses packages with multiple masters and layouts', async () => {
    const source = await createMultiMasterTemplateDeck()
    const original = new AdmZip(source)
    const generated = await createPptxFromTemplate(
      source,
      'multi-master.pptx',
      [
        { title: 'Master one page', bullets: ['Primary layout'], templateSlideNumber: 1 },
        { title: 'Master two page', bullets: ['Secondary layout'], templateSlideNumber: 3 }
      ],
      { file_path: 'multi-master.pptx', mode: 'new-deck' }
    )
    const output = new AdmZip(generated.buffer)

    expect(generated.summary.mastersPreserved).toBe(2)
    expect(generated.summary.layoutsPreserved).toBe(2)
    expect(output.readFile('ppt/slideMasters/slideMaster2.xml')).toEqual(
      original.readFile('ppt/slideMasters/slideMaster2.xml')
    )
    expect(output.readFile('ppt/slideLayouts/slideLayout2.xml')).toEqual(
      original.readFile('ppt/slideLayouts/slideLayout2.xml')
    )
    expect(output.readAsText('ppt/slides/_rels/slide2.xml.rels')).toContain('slideLayout2.xml')

    const verification = await verifyGeneratedOutput({
      format: 'pptx',
      buffer: generated.buffer,
      expectedSlides: 2,
      renderValidation: 'skip'
    })
    expect(verification.passed).toBe(true)
  })

  it('maps standard PowerPoint title, subtitle, and body placeholders before geometry fallback', async () => {
    const source = await createTemplateDeck()
    const template = new AdmZip(source)
    let slideXml = template.readAsText('ppt/slides/slide1.xml')
    slideXml = applyStandardPlaceholder(slideXml, 'Title', 'title', 'Generic title placeholder')
    slideXml = applyStandardPlaceholder(slideXml, 'Kicker', 'subTitle', 'Generic subtitle placeholder')
    slideXml = applyStandardPlaceholder(slideXml, 'Tag 1', 'body', 'Generic body placeholder')
    template.updateFile('ppt/slides/slide1.xml', Buffer.from(slideXml, 'utf-8'))

    const generated = await createPptxFromTemplate(
      template.toBuffer(),
      'placeholder-template.pptx',
      [
        {
          title: 'Mapped by title placeholder',
          subtitle: 'Mapped by subtitle placeholder',
          bullets: ['Mapped by body placeholder'],
          targetSlideNumber: 1
        }
      ],
      { file_path: 'placeholder-template.pptx', mode: 'edit-copy' }
    )
    const outputXml = new AdmZip(generated.buffer).readAsText('ppt/slides/slide1.xml')

    expect(outputXml).toContain('Mapped by title placeholder')
    expect(outputXml).toContain('Mapped by subtitle placeholder')
    expect(outputXml).toContain('Mapped by body placeholder')
    expect(generated.summary.warnings).not.toContain(expect.stringContaining('no title placeholder'))
  })

  it('keeps the first generic repeated slot and treats a leading year as heading content', async () => {
    const template = new AdmZip(await createTemplateDeck())
    let sequence = 1
    const genericSlide = template
      .readAsText('ppt/slides/slide2.xml')
      .replace(/\bname="[^"]*"/g, () => `name="TextBox ${sequence++}"`)
    template.updateFile('ppt/slides/slide2.xml', Buffer.from(genericSlide, 'utf-8'))

    const generated = await createPptxFromTemplate(
      template.toBuffer(),
      'generic-textbox-template.pptx',
      [
        {
          title: '年度行动安排',
          layout: 'cards',
          bullets: ['需求识别 | 建立日常观察', '2027 行动 | 资源优先投向连续支持', '成效复盘 | 按季度回看变化'],
          targetSlideNumber: 2
        }
      ],
      { file_path: 'generic-textbox-template.pptx', mode: 'edit-copy' }
    )
    const outputXml = new AdmZip(generated.buffer).readAsText('ppt/slides/slide2.xml')

    expect(outputXml).toContain('需求识别')
    expect(outputXml).toContain('建立日常观察')
    expect(outputXml).toContain('2027 行动')
    expect(outputXml).toContain('资源优先投向连续支持')
    expect(outputXml).toContain('成效复盘')
  })

  it('rewrites native chart caches and removes stale fixed value-axis bounds', async () => {
    const chartXml = rewriteTemplateChartXml(
      '<c:chartSpace><c:chart><c:plotArea><c:barChart><c:ser><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>原始趋势</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$4</c:f><c:strCache><c:ptCount val="3"/><c:pt idx="0"><c:v>2021</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$B$2:$B$4</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="3"/><c:pt idx="0"><c:v>68</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart><c:valAx><c:scaling><c:orientation val="minMax"/><c:max val="75"/><c:min val="65"/></c:scaling><c:majorUnit val="2"/></c:valAx></c:plotArea></c:chart></c:chartSpace>',
      {
        title: '支持连续性指数',
        layout: 'chart',
        bullets: ['日常触点:78', '主动识别:64', '转介可达:58', '持续跟踪:41']
      },
      [
        { label: '日常触点', value: 78 },
        { label: '主动识别', value: 64 },
        { label: '转介可达', value: 58 },
        { label: '持续跟踪', value: 41 }
      ]
    )

    expect(chartXml).toContain('日常触点')
    expect(chartXml).toContain('持续跟踪')
    expect(chartXml).toContain('<c:ptCount val="4"/>')
    expect(chartXml).not.toMatch(/<c:(?:min|max|majorUnit)\b/)
  })

  it('replaces the dominant template picture while preserving its native slide geometry', async () => {
    const originalImage = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#39734D' } })
      .png()
      .toBuffer()
    const replacementImage = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#D6A84B' } })
      .png()
      .toBuffer()
    const style = resolveDocumentStyle({
      visualStyle: 'editorial',
      title: 'Photo template',
      content: '',
      format: 'pptx'
    })
    const source = await createPptxBuffer(
      [
        { title: 'Photo template', layout: 'image', accent: 'green', bullets: ['Original image'], imageAssetId: 'hero' }
      ],
      new Map([
        [
          'hero',
          {
            id: 'hero',
            sourcePath: 'original.png',
            data: originalImage,
            width: 1280,
            height: 720,
            altText: 'Original image'
          }
        ]
      ]),
      style
    )
    const original = new AdmZip(source)
    const generated = await createPptxFromTemplate(
      source,
      'reference.pptx',
      [
        {
          title: 'Preserved photo template',
          bullets: [],
          imageAssetId: 'replacement',
          templateSlideNumber: 1,
          preserveContent: true
        }
      ],
      { file_path: 'reference.pptx', mode: 'new-deck' },
      new Map([
        [
          'replacement',
          {
            id: 'replacement',
            sourcePath: 'replacement.png',
            data: replacementImage,
            width: 1280,
            height: 720,
            altText: 'Replacement image'
          }
        ]
      ])
    )
    const output = new AdmZip(generated.buffer)

    expect(output.readFile('ppt/slides/slide1.xml')).toEqual(original.readFile('ppt/slides/slide1.xml'))
    expect(output.readAsText('ppt/slides/_rels/slide1.xml.rels')).toContain('../media/zen-ai-template-1.png')
    expect(output.readFile('ppt/media/zen-ai-template-1.png')).toEqual(replacementImage)
    expect(output.readAsText('[Content_Types].xml')).toContain('Extension="png"')
  })

  it('blocks severely underfilled content when a dense native source layout is selected', async () => {
    const style = resolveDocumentStyle({
      visualStyle: 'research',
      title: 'Dense evidence template',
      content: '',
      format: 'pptx'
    })
    const source = await createPptxBuffer(
      [
        { title: 'Dense evidence template', layout: 'cover', accent: 'blue', bullets: ['Annual review'] },
        {
          title: 'Four findings require evidence and interpretation',
          layout: 'cards',
          accent: 'blue',
          bullets: [
            'Coverage | The monitoring network now reaches all priority areas, but seasonal gaps still affect winter observations and require targeted supplementary sampling.',
            'Continuity | Five years of comparable data reveal a stable improvement trend, while two corridors remain below the intervention threshold.',
            'Response | Alert-to-verification time fell after cross-region dispatching was introduced, yet remote sites still need a clearer escalation path.',
            'Action | The next cycle should connect funding, field tasks, evidence capture, and quarterly review so every intervention can be verified.'
          ]
        }
      ],
      new Map(),
      style
    )
    const profiles = profilePptxTemplateSlides(source)
    expect(profiles[1].contentDensity).toBe('dense')
    expect(profiles[1].targetBodyTextUnitsMin).toBeGreaterThan(100)

    await expect(
      createPptxFromTemplate(
        source,
        'dense-template.pptx',
        [
          {
            title: 'New findings',
            layout: 'cards',
            bullets: ['Coverage | Better', 'Continuity | Improving', 'Response | Faster', 'Action | Continue'],
            templateSlideNumber: 2
          }
        ],
        { file_path: 'dense-template.pptx', mode: 'new-deck' }
      )
    ).rejects.toThrow(/content planning is too sparse/i)
  })
})
