import AdmZip from 'adm-zip'
import { XMLParser } from 'fast-xml-parser'

type VisibleSlideContent = {
  title: string
  subtitle?: string
  takeaway?: string
  bullets: string[]
  layout?: string
}

// Check generated slide bodies only, never speaker notes or internal design instructions.
// This is a content-loss guard, not a rendered layout or factual-accuracy assessment.
export function validatePptxVisibleContent(buffer: Buffer, slides: VisibleSlideContent[]): void {
  const zip = new AdmZip(buffer)
  const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: false })
  for (const [index, slide] of slides.entries()) {
    const entry = zip.getEntry(`ppt/slides/slide${index + 1}.xml`)
    if (!entry || entry.header.size > 8 * 1024 * 1024) {
      throw new Error(`Office quality validation: slide ${index + 1} body is missing or exceeds the safe limit.`)
    }
    const visible: string[] = []
    collectText(parser.parse(entry.getData().toString('utf8')), visible)
    const body = normalizeText(visible.join(' '))
    // Quote layouts deliberately use the title as metadata when an actual quote is supplied.
    // Other layouts may select one of subtitle/takeaway as their premise, not render both.
    const fields = [
      slide.layout === 'quote' && (slide.takeaway || slide.bullets[0]) ? '' : slide.title,
      ...slide.bullets
    ]
    const premises = [slide.subtitle, slide.takeaway].filter((value): value is string => Boolean(value))
    if (premises.length && !premises.some((value) => body.includes(normalizeText(value)))) {
      throw new Error(
        `Office quality validation: visible content missing on slide ${index + 1} (premise). Choose a fitting layout or move supporting detail into a continuation slide.`
      )
    }
    for (const [fieldIndex, field] of fields.entries()) {
      // Layouts may separate "heading: detail" or "period | milestone" into independent shapes.
      const parts = (field || '')
        .split(/[|｜:：]/)
        .map(normalizeText)
        .filter(Boolean)
      if (parts.some((part) => !body.includes(part))) {
        throw new Error(
          `Office quality validation: visible content missing on slide ${index + 1} (${fieldIndex === 0 ? 'title' : `bullet ${fieldIndex}`}). Split the content into continuation slides or select a layout that fits all supplied text.`
        )
      }
    }
  }
}

function normalizeText(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, '')
}

function collectText(value: unknown, result: string[], depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 32) return
  if (Array.isArray(value)) {
    for (const child of value) collectText(child, result, depth + 1)
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'a:t') {
      for (const text of Array.isArray(child) ? child : [child]) {
        if (typeof text === 'string') result.push(text)
      }
    } else collectText(child, result, depth + 1)
  }
}
