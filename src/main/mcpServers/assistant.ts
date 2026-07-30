import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { loggerService } from '@logger'
import { ocrService } from '@main/services/ocr/OcrService'
import { managedPythonService } from '@main/services/python/ManagedPythonService'
import { toAsarUnpackedPath } from '@main/utils'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js'
import fontkit from '@pdf-lib/fontkit'
import { BuiltinOcrProviderIds, FILE_TYPE, type ImageFileMetadata, type OcrProvider, type OcrResult } from '@types'
import AdmZip from 'adm-zip'
import { app } from 'electron'
import { XMLBuilder, XMLParser } from 'fast-xml-parser'
import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from 'pdf-lib'
import { PDFParse } from 'pdf-parse'
import PptxGenJS from 'pptxgenjs'

import {
  findImageAssetReferences,
  fitImageWithin,
  type ImageAssetInput,
  type LoadedImageAsset,
  loadImageAssets,
  validateImageAssetUsage
} from './assistantAssets'
import {
  type BrandThemeInput,
  DOCUMENT_STYLE_MODES,
  DOCUMENT_TYPE_SUGGESTIONS,
  type DocumentStyleMode,
  type ResolvedDocumentStyle,
  resolveDocumentStyle,
  VISUAL_STYLE_IDS
} from './assistantDocumentStyles'
import { createDocxBuffer } from './assistantDocx'
import { verifyGeneratedOutput } from './assistantOutputValidation'
import {
  analyzePptxBuffer,
  analyzePptxStyleReference,
  applyPptxReferenceFonts,
  comparePptxReferenceComposition,
  comparePptxReferenceDesignLanguage,
  isImageHeavyPptxReference,
  type PptxDesignLanguageProfile,
  type PptxReferenceSlidePattern,
  pptxReferenceSummary,
  type PptxStyleReferenceInput,
  type PptxStyleReferenceProfile,
  referenceBrandTheme
} from './assistantPptxReference'
import {
  createPptxFromTemplate,
  type PptxTemplateInput,
  type PptxTemplateSummary,
  pptxTemplateSummary,
  profilePptxTemplateSlides
} from './assistantPptxTemplate'
import { createXlsxBuffer, type WorkbookInput } from './assistantXlsx'

const logger = loggerService.withContext('MCPServer:Assistant')

// Allowed route prefixes to prevent arbitrary navigation
const ALLOWED_ROUTES = [
  '/settings/',
  '/agents',
  '/knowledge',
  '/openclaw',
  '/paintings',
  '/translate',
  '/files',
  '/notes',
  '/apps',
  '/code',
  '/store',
  '/launchpad',
  '/'
]

const NAVIGATE_TOOL: Tool = {
  name: 'navigate',
  description: 'Navigate Zen AI to a specific page. Refer to the route table in your skills for available paths.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The route path to navigate to, e.g. /settings/provider, /settings/mcp/servers'
      },
      query: {
        type: 'object',
        description: 'Optional URL query parameters, e.g. { "id": "anthropic" }',
        additionalProperties: { type: 'string' }
      }
    },
    required: ['path']
  }
}

const DIAGNOSE_TOOL: Tool = {
  name: 'diagnose',
  description:
    'Read Zen AI runtime state for troubleshooting. Use this to inspect app info, provider config, connectivity, logs, and MCP server status.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['info', 'providers', 'health', 'logs', 'errors', 'mcp_status', 'read_source', 'config', 'python'],
        description:
          'info: app version/paths/system. providers: list configured providers. health: test provider connectivity (cached 30s). logs: read recent log entries. errors: extract only ERROR/WARN entries from logs. mcp_status: check MCP server states. read_source: read a source file (read-only). config: read user settings. python: inspect the Zen AI managed Python runtime.'
      },
      provider_id: {
        type: 'string',
        description: 'Provider ID for the health action'
      },
      lines: {
        type: 'number',
        description: 'Number of log lines to return (default 50, max 500)'
      },
      file_path: {
        type: 'string',
        description: 'Relative file path for read_source action, e.g. src/main/services/MCPService.ts'
      }
    },
    required: ['action']
  }
}

const INSPECT_PPTX_TEMPLATE_TOOL: Tool = {
  name: 'inspect_pptx_template',
  description:
    'Inspect an editable PPTX template before planning a new-topic deck. Returns deck-level design language, rhythm and density targets plus each source page archetype, capacity, arrangement, media requirements, chart type, and safe text-density range. Call this internally for native-template requests; preserve the visual language while selecting, recomposing, or avoiding source layouts according to the new content. Do not ask the user to provide page mappings or engineering constraints.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Authorized source .pptx path inside the current workspace or allowed user directory.'
      }
    },
    required: ['file_path']
  }
}

const CREATE_FILE_TOOL: Tool = {
  name: 'create_file',
  description: `Create a valid common output file using Zen AI's built-in document generator.
Use this for user-requested MD/TXT/CSV/DOCX/XLSX/PPTX/PDF output before improvising Python or shell scripts.
It is designed for reliable basic documents, spreadsheets, slides, and text files without requiring pandas, python-docx, openpyxl, python-pptx, or system Python.
For advanced spreadsheets, pass a structured workbook definition with sheets, formulas, filters, freezes, conditional formats, and charts. For PDFs, markdown-like headings, lists, and pipe tables are laid out with pagination.
For unsupported document features, explain the limitation or use an approved dependency only when truly required.
The output path must be inside an allowed user/workspace location. The tool creates parent folders and returns verification metadata.`,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description:
          'Absolute or relative output path, e.g. "report.docx" or "C:\\\\Users\\\\name\\\\Desktop\\\\report.docx".'
      },
      format: {
        type: 'string',
        enum: ['md', 'txt', 'csv', 'docx', 'xlsx', 'pptx', 'pdf'],
        description: 'Optional file format. If omitted, the format is inferred from file_path extension.'
      },
      title: {
        type: 'string',
        description: 'Optional title used by DOCX/PPTX/PDF output.'
      },
      content: {
        type: 'string',
        description:
          'Main text or markdown-like content. For CSV/XLSX this may be comma/tab/newline separated when rows are not provided.'
      },
      visual_style: {
        type: 'string',
        enum: [...VISUAL_STYLE_IDS],
        description:
          'Document-level visual style. Omit to infer it from the topic, audience, document_type, title, and content. When pptx_style_reference is supplied, the reference determines the PPTX layout language and this field is ignored. Applies consistently across the whole PPTX, DOCX, or PDF instead of rotating unrelated colors.'
      },
      document_type: {
        type: 'string',
        description: `Semantic document archetype used for structure and automatic style selection. PPTX examples: ${DOCUMENT_TYPE_SUGGESTIONS.pptx.join(', ')}. DOCX examples: ${DOCUMENT_TYPE_SUGGESTIONS.docx.join(', ')}. PDF examples: ${DOCUMENT_TYPE_SUGGESTIONS.pdf.join(', ')}.`
      },
      style_mode: {
        type: 'string',
        enum: [...DOCUMENT_STYLE_MODES],
        description:
          'Overall rendering mode. auto follows the selected style; light is screen-friendly; dark is presentation/PDF oriented; print is grayscale and print-friendly. DOCX keeps a light editable page even when a dark style family is selected.'
      },
      brand_theme: {
        type: 'object',
        description:
          'Optional brand color override: { name?, primary_color?, secondary_color?, accent_color? }. Colors use six-digit hex, with or without #. Brand colors override the selected style while preserving its layout language.',
        properties: {
          name: { type: 'string' },
          primary_color: { type: 'string' },
          secondary_color: { type: 'string' },
          accent_color: { type: 'string' }
        }
      },
      pptx_style_reference: {
        type: 'object',
        description:
          'Optional approximate PPTX or slide-screenshot style reference: { file_path, slide_number? }. A PPTX reference leads palette, fonts, design language, page archetypes, light/dark rhythm, media density, chart cadence, information density, and layout diversity; slide_number emphasizes one page without replacing whole-deck rhythm. A screenshot also contributes composition bias, spatial rhythm, edge/texture character, approximate photographic coverage, image treatment, and surface treatment, but cannot recover exact fonts, icons, coordinates, masters, or editable source objects. Image-heavy PPTX references require enough distinct topic-relevant local assets plus image_asset_id assignments. PPTX composition similarity below 70/100 or severe cadence/diversity/density loss blocks delivery; screenshot design-language similarity is reported for rendered review. Use pptx_template edit-copy/new-deck only when the user expects native page geometry or object preservation; colloquial use of the word template may still be visual guidance.',
        properties: {
          file_path: { type: 'string' },
          slide_number: {
            type: 'integer',
            minimum: 1,
            description: 'Optional 1-based slide number for a .pptx reference. Omit to aggregate up to 12 slides.'
          }
        },
        required: ['file_path']
      },
      pptx_template: {
        type: 'object',
        description:
          "Optional PPTX template or design-language reuse. A terse user request naming a source template and a new topic is complete: call inspect_pptx_template internally, extract its design language and density targets, author a new-topic storyline, then choose the strategy automatically. Use edit-copy for selected-page edits, new-deck when source page structures fit the new story, and adaptive-design when the source is mainly a visual reference or several required page semantics do not fit its layout inventory. Preserve the source's overall visual beauty rather than mechanically copying its old content structure. Infer output name, page mapping, media replacement, source protection, validation, and retry defaults without follow-up prompting. A new-deck slide image_asset_id replaces that source slide's dominant picture while preserving its original crop and bounds.",
        properties: {
          file_path: { type: 'string' },
          mode: {
            type: 'string',
            enum: ['edit-copy', 'new-deck', 'adaptive-design'],
            description:
              'edit-copy preserves all source slides; new-deck reuses native source pages; adaptive-design extracts visual language and generates content-fit layouts without forcing source geometry.'
          },
          source_slide_number: {
            type: 'integer',
            minimum: 1,
            description: 'Default 1-based template slide used by new-deck when a slide does not override it.'
          },
          target_slide_number: {
            type: 'integer',
            minimum: 1,
            description: 'Default 1-based source slide edited by edit-copy when one slide update is supplied.'
          },
          shape_replacements: {
            type: 'array',
            maxItems: 64,
            description:
              'Optional exact text-shape replacements: [{ slide_number?, shape_name?, find_text?, text }]. Match by shape name, existing visible text, or both.',
            items: {
              type: 'object',
              properties: {
                slide_number: { type: 'integer', minimum: 1 },
                shape_name: { type: 'string' },
                find_text: { type: 'string' },
                text: { type: 'string' }
              },
              required: ['text']
            }
          }
        },
        required: ['file_path', 'mode']
      },
      render_validation: {
        type: 'string',
        enum: ['auto', 'required', 'skip'],
        description:
          'Visual validation policy. auto renders PDFs and uses LibreOffice for Office files when available; required also attempts Microsoft Office on Windows and fails if rendering cannot be completed; skip records that visual validation was skipped.'
      },
      rows: {
        type: 'array',
        description: 'Optional table rows for CSV/XLSX. Each row is an array of cell values.',
        items: {
          type: 'array',
          items: {
            type: ['string', 'number', 'boolean', 'null']
          }
        }
      },
      workbook: {
        type: 'object',
        description:
          'Advanced XLSX definition. Use { creator?, sheets: [{ name, rows, header_rows?, freeze_rows?, freeze_columns?, auto_filter?, column_widths?, merges?, conditional_formats?, charts? }] }. Formula cells use { formula, result, style? }; chart series must include cached categories and numeric values.',
        additionalProperties: true
      },
      assets: {
        type: 'array',
        maxItems: 24,
        description:
          'Local image assets for DOCX/PPTX/PDF. Each item is { id, file_path, alt_text? }. Reference an asset in DOCX/PDF content as ![Alt](asset:id), or from a PPTX slide with image_asset_id.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            file_path: { type: 'string' },
            alt_text: { type: 'string' }
          },
          required: ['id', 'file_path']
        }
      },
      slides: {
        type: 'array',
        description: 'Optional slide definitions for PPTX. If omitted, content is split into basic slides.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            subtitle: { type: 'string' },
            layout: {
              type: 'string',
              enum: [
                'cover',
                'agenda',
                'section',
                'insight',
                'cards',
                'process',
                'timeline',
                'network',
                'matrix',
                'schedule',
                'route',
                'comparison',
                'metric',
                'chart',
                'image',
                'quote',
                'summary'
              ],
              description:
                'Semantic composition. network uses node | detail, matrix uses quadrant | detail, schedule uses time | event: detail, and route uses stop | milestone: detail.'
            },
            image_asset_id: {
              type: 'string',
              description: 'ID of an item in assets. The slide uses an image-safe layout and embeds the media.'
            },
            template_slide_number: {
              type: 'integer',
              minimum: 1,
              description:
                'For pptx_template new-deck, the preferred 1-based source slide. Inspect the template first and match the new slide semantics and item count; the generator may remap an unsafe choice to a compatible page.'
            },
            target_slide_number: {
              type: 'integer',
              minimum: 1,
              description: 'For pptx_template edit-copy, the 1-based source slide updated by this slide definition.'
            },
            preserve_content: {
              type: 'boolean',
              description:
                'For pptx_template new-deck only. Copies the selected source slide content unchanged while preserving its native layout, relationships, and media. Cannot be combined with shape replacements on that output slide.'
            },
            takeaway: { type: 'string' },
            visual: { type: 'string' },
            accent: {
              type: 'string',
              enum: ['blue', 'green', 'amber', 'purple', 'cyan', 'coral', 'red', 'slate']
            },
            bullets: {
              type: 'array',
              items: { type: 'string' }
            },
            notes: { type: 'string' }
          }
        }
      }
    },
    required: ['file_path']
  }
}

const PYTHON_EXECUTE_TOOL: Tool = {
  name: 'python_execute',
  description: `Execute Python with Zen AI's private managed CPython runtime.
Use it for data cleaning, analysis, chart preparation, complex transformations, and bundled Skill scripts. The runtime is isolated from the user's system Python and includes the standard productivity package set.
Do not run pip, uv, conda, package installers, shell commands, desktop automation, or destructive file operations from this tool. Use create_file for ordinary Office generation and ocr_file for OCR.
The working directory must be inside an allowed workspace/user folder.`,
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'Python source code to execute. Provide code or script_path, not both.'
      },
      script_path: {
        type: 'string',
        description: 'Optional path to an authorized bundled/workspace .py script.'
      },
      arguments: {
        type: 'array',
        maxItems: 64,
        items: { type: 'string' },
        description: 'Arguments passed to script_path. Not used with inline code.'
      },
      working_directory: {
        type: 'string',
        description: 'Optional absolute or workspace-relative working directory. It must be inside an allowed root.'
      },
      timeout_ms: {
        type: 'number',
        minimum: 1000,
        maximum: 300000,
        description: 'Execution timeout in milliseconds. Defaults to 120000 and is capped at 300000.'
      }
    }
  }
}

const OCR_FILE_TOOL: Tool = {
  name: 'ocr_file',
  description: `Recognize text in a local image or scanned PDF with Zen AI's built-in OCR.
Use this tool instead of installing or improvising a Python OCR package. Auto mode prefers the operating-system OCR on Windows/macOS, but evaluates the result and compares Tesseract for mixed Chinese/English content or when spacing and line structure look unreliable. Simplified Chinese and English are enabled by default; request zh-tw explicitly for Traditional Chinese.
TXT and Markdown output preserve available reading order, line breaks, and paragraphs; they do not reproduce exact page coordinates or typography.
For PDFs, pages are rendered locally and processed in order. The input and optional output paths must be inside allowed workspace/user folders.`,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute or workspace-relative path to an image or PDF.'
      },
      provider: {
        type: 'string',
        enum: ['auto', 'system', 'tesseract'],
        default: 'auto',
        description: 'OCR provider. Auto quality-checks system OCR and falls back to Tesseract when needed.'
      },
      languages: {
        type: 'array',
        items: { type: 'string', enum: ['zh-cn', 'zh-tw', 'en-us'] },
        description:
          'Recognition languages. Defaults to simplified Chinese and English; add zh-tw for Traditional Chinese.'
      },
      pages: {
        type: 'array',
        items: { type: 'integer', minimum: 1 },
        maxItems: 50,
        description: 'Optional 1-based PDF page numbers. When omitted, the first max_pages pages are processed.'
      },
      max_pages: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 20,
        description: 'Maximum number of PDF pages processed in one call.'
      },
      output_path: {
        type: 'string',
        description: 'Optional .txt or .md path for the full OCR text.'
      }
    },
    required: ['file_path']
  }
}

// Health check cache: { providerId -> { result, timestamp } }
const healthCache = new Map<string, { result: unknown; timestamp: number }>()
const HEALTH_CACHE_TTL = 30_000 // 30 seconds
const SUPPORTED_FILE_FORMATS = ['md', 'txt', 'csv', 'docx', 'xlsx', 'pptx', 'pdf'] as const
const SUPPORTED_OCR_IMAGE_EXTENSIONS = new Set(['.bmp', '.gif', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp'])
const MAX_OCR_RESPONSE_CHARS = 120_000

type SupportedFileFormat = (typeof SUPPORTED_FILE_FORMATS)[number]
type CellValue = string | number | boolean | null

interface SlideInput {
  title?: string
  subtitle?: string
  layout?: string
  takeaway?: string
  visual?: string
  accent?: string
  bullets?: string[]
  notes?: string
  image_asset_id?: string
  preserve_content?: boolean
  template_slide_number?: number
  target_slide_number?: number
}

interface CreateFileArgs {
  file_path?: string
  format?: string
  title?: string
  content?: string
  visual_style?: string
  document_type?: string
  style_mode?: DocumentStyleMode
  brand_theme?: BrandThemeInput
  pptx_style_reference?: PptxStyleReferenceInput
  pptx_template?: PptxTemplateInput
  rows?: CellValue[][]
  workbook?: WorkbookInput
  slides?: SlideInput[]
  assets?: ImageAssetInput[]
  render_validation?: 'auto' | 'required' | 'skip'
}

interface PythonExecuteArgs {
  code?: string
  script_path?: string
  arguments?: string[]
  working_directory?: string
  timeout_ms?: number
}

interface OcrFileArgs {
  file_path?: string
  provider?: 'auto' | 'system' | 'tesseract'
  languages?: Array<'zh-cn' | 'zh-tw' | 'en-us'>
  pages?: number[]
  max_pages?: number
  output_path?: string
}

type OcrLanguage = NonNullable<OcrFileArgs['languages']>[number]

interface OcrPageResult {
  page: number
  provider: string
  text: string
  quality: OcrTextQuality
  candidateCount: number
  confidence?: number
}

interface OcrCandidate {
  provider: 'system' | 'tesseract'
  label: string
  text: string
  quality: OcrTextQuality
  confidence?: number
}

interface OcrTextQuality {
  score: number
  shouldFallback: boolean
  characterCount: number
  lineBreaks: number
  cjkSpacingRatio: number
  isolatedLetterRatio: number
  joinedWordRatio?: number
  invalidCharacters: number
  paragraphCount?: number
  scriptMismatchCharacters?: number
}

const CJK_CHARACTER_CLASS = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff'

function isUnsupportedControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? -1
  return (
    (codePoint >= 0 && codePoint <= 8) ||
    codePoint === 11 ||
    codePoint === 12 ||
    (codePoint >= 14 && codePoint <= 31) ||
    codePoint === 127
  )
}

function stripUnsupportedControlCharacters(value: string): string {
  return [...value].filter((character) => !isUnsupportedControlCharacter(character)).join('')
}

function normalizeOcrText(rawText: string) {
  return stripUnsupportedControlCharacters(rawText.normalize('NFC').replace(/\r\n?/g, '\n'))
    .split('\n')
    .map((line) =>
      line
        .trim()
        .replace(new RegExp(`([${CJK_CHARACTER_CLASS}])[ \\t]+(?=[${CJK_CHARACTER_CLASS}])`, 'gu'), '$1')
        .replace(new RegExp(`([${CJK_CHARACTER_CLASS}])[ \\t]+([，。！？；：、）》】])`, 'gu'), '$1$2')
        .replace(new RegExp(`([（《【])[ \\t]+([${CJK_CHARACTER_CLASS}])`, 'gu'), '$1$2')
        .replace(/[ \t]{3,}/g, ' ')
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function assessOcrTextQuality(rawText: string): OcrTextQuality {
  const normalizedLineEndings = rawText.replace(/\r\n?/g, '\n')
  const characterCount = [...normalizedLineEndings].filter((character) => !/\s/u.test(character)).length
  const lineBreaks = (normalizedLineEndings.match(/\n/g) ?? []).length
  const cjkCharacters = normalizedLineEndings.match(new RegExp(`[${CJK_CHARACTER_CLASS}]`, 'gu')) ?? []
  const cjkSpacing =
    normalizedLineEndings.match(new RegExp(`[${CJK_CHARACTER_CLASS}][ \\t]+(?=[${CJK_CHARACTER_CLASS}])`, 'gu')) ?? []
  const cjkSpacingRatio = cjkCharacters.length > 1 ? cjkSpacing.length / (cjkCharacters.length - 1) : 0
  const asciiWords = normalizedLineEndings.match(/[A-Za-z]+/g) ?? []
  const isolatedLetters = asciiWords.filter((word) => word.length === 1 && !/^[aAiI]$/.test(word)).length
  const isolatedLetterRatio = asciiWords.length > 0 ? isolatedLetters / asciiWords.length : 0
  const joinedWords = asciiWords.filter(
    (word) =>
      /(?:inthe|ofthe|tothe|andthe|forthe|forthis|withthe|fromthe|onthe|atthe|untilthe|untillast)$/iu.test(word) &&
      word.length >= 6
  ).length
  const joinedWordRatio = asciiWords.length > 0 ? joinedWords / asciiWords.length : 0
  const invalidCharacters = [...normalizedLineEndings].filter(
    (character) => character === '\ufffd' || isUnsupportedControlCharacter(character)
  ).length
  const longSingleLine = characterCount >= 320 && lineBreaks === 0

  let score = 100
  if (characterCount < 8) score -= 70
  else if (characterCount < 32) score -= 20
  if (longSingleLine) score -= 35
  score -= Math.min(35, cjkSpacingRatio * 55)
  score -= Math.min(20, isolatedLetterRatio * 80)
  score -= Math.min(20, joinedWordRatio * 100)
  score -= Math.min(30, invalidCharacters * 6)

  return {
    score: Math.max(0, Math.round(score * 10) / 10),
    shouldFallback:
      characterCount < 8 ||
      longSingleLine ||
      cjkSpacingRatio >= 0.08 ||
      isolatedLetterRatio >= 0.08 ||
      joinedWordRatio >= 0.02 ||
      invalidCharacters > 0,
    characterCount,
    lineBreaks,
    cjkSpacingRatio,
    isolatedLetterRatio,
    joinedWordRatio,
    invalidCharacters
  }
}

function chooseBestOcrCandidate(candidates: OcrCandidate[]) {
  const maximumCharacterCount = Math.max(...candidates.map((candidate) => candidate.quality.characterCount), 1)
  return candidates.reduce((best, candidate) => {
    const coverage = candidate.quality.characterCount / maximumCharacterCount
    const adjustedScore = candidate.quality.score - Math.max(0, 0.65 - coverage) * 50
    const bestCoverage = best.quality.characterCount / maximumCharacterCount
    const bestAdjustedScore = best.quality.score - Math.max(0, 0.65 - bestCoverage) * 50
    return adjustedScore > bestAdjustedScore ? candidate : best
  })
}

function createAssistantOcrProvider(
  providerId: 'system' | 'tesseract',
  languages: OcrLanguage[],
  preprocess: 'auto' | 'high-contrast' = 'auto'
): OcrProvider {
  if (providerId === BuiltinOcrProviderIds.system) {
    return {
      id: providerId,
      name: 'System OCR',
      capabilities: { image: true },
      config: { langs: languages, preprocess }
    } as OcrProvider
  }

  const languageMap = {
    'zh-cn': 'chi_sim',
    'zh-tw': 'chi_tra',
    'en-us': 'eng'
  } as const
  return {
    id: providerId,
    name: 'Tesseract',
    capabilities: { image: true },
    config: {
      langs: Object.fromEntries(languages.map((language) => [languageMap[language], true])),
      preprocess
    }
  } as OcrProvider
}

const LIKELY_TRADITIONAL_CHARACTERS = new Set([
  ...'\u5E7E\u8207\u70BA\u65BC\u9577\u9580\u958B\u95DC\u5F8C\u88E1\u9019\u500B\u4F86\u6642\u6703\u767C\u73FE\u61C9\u5C0D\u904E\u9084\u842C\u7121\u4E26\u696D\u6771\u8ECA\u66F8\u570B\u83EF\u81FA\u7063\u5B78\u7FD2\u9AD4\u52D9\u7368\u96E2\u8CA1\u986F\u8C9D\u5167\u7372\u9EE8\u54E1\u9078\u8209\u64D4\u8A72\u7A2E\u932F\u8655\u8CC7\u8A0A\u5BE6\u969B'
])

function formatOcrResult(result: OcrResult) {
  const rawText = normalizeOcrPunctuation(result.text)
  const lines = result.lines?.filter((line) => line.text.trim()) ?? []
  if (lines.length < 2) return rawText

  const structured: string[] = []
  let previousParagraph: number | undefined
  for (const line of lines) {
    if (
      structured.length > 0 &&
      line.paragraph !== undefined &&
      previousParagraph !== undefined &&
      line.paragraph !== previousParagraph
    ) {
      structured.push('')
    }
    structured.push(line.text)
    previousParagraph = line.paragraph
  }
  const structuredText = normalizeOcrPunctuation(structured.join('\n'))
  return visibleOcrCharacterCount(structuredText) >= visibleOcrCharacterCount(rawText) * 0.7 ? structuredText : rawText
}

function normalizeOcrPunctuation(rawText: string) {
  return normalizeOcrText(rawText)
    .split('\n')
    .map((line) =>
      line
        .replace(
          new RegExp(
            `([${CJK_CHARACTER_CLASS}])[ \\t]+([\\uFF0C\\u3002\\uFF01\\uFF1F\\uFF1B\\uFF1A\\u3001\\uFF09\\u300B\\u3011])`,
            'gu'
          ),
          '$1$2'
        )
        .replace(new RegExp(`([\\uFF08\\u300A\\u3010])[ \\t]+([${CJK_CHARACTER_CLASS}])`, 'gu'), '$1$2')
        .replace(/[ \\t]+([,.;:!?])/g, '$1')
    )
    .join('\n')
}

function assessOcrCandidateQuality(text: string, languages: OcrLanguage[], confidence?: number): OcrTextQuality {
  const quality = assessOcrTextQuality(text)
  const scriptMismatchCharacters =
    languages.includes('zh-cn') && !languages.includes('zh-tw')
      ? [...text].filter((character) => LIKELY_TRADITIONAL_CHARACTERS.has(character)).length
      : 0
  const paragraphCount = text.split(/\n\s*\n/).filter((paragraph) => paragraph.trim()).length
  let score = quality.score - Math.min(25, scriptMismatchCharacters * 1.5)
  if (confidence !== undefined && confidence < 70) score -= Math.min(25, (70 - confidence) * 0.6)
  if (confidence !== undefined) score = Math.min(score, confidence)
  return {
    ...quality,
    score: Math.max(0, Math.round(score * 10) / 10),
    shouldFallback:
      quality.shouldFallback || scriptMismatchCharacters >= 4 || (confidence !== undefined && confidence < 55),
    paragraphCount,
    scriptMismatchCharacters
  }
}

function chooseBestOcrCandidateV2(candidates: OcrCandidate[]) {
  const baseline = chooseBestOcrCandidate(candidates)
  const maximumCharacterCount = Math.max(...candidates.map((candidate) => candidate.quality.characterCount), 1)
  return candidates.reduce((best, candidate) => {
    const score = adjustedOcrCandidateScore(candidate, maximumCharacterCount)
    const bestScore = adjustedOcrCandidateScore(best, maximumCharacterCount)
    if (score === bestScore) return candidate === baseline ? candidate : best
    return score > bestScore ? candidate : best
  }, baseline)
}

function adjustedOcrCandidateScore(candidate: OcrCandidate, maximumCharacterCount: number) {
  const coverage = candidate.quality.characterCount / maximumCharacterCount
  return candidate.quality.score - Math.max(0, 0.65 - coverage) * 50
}

function visibleOcrCharacterCount(value: string) {
  return [...value].filter((character) => !/\s/u.test(character)).length
}

function shouldCompareOcrEngines(languages: OcrLanguage[]) {
  return languages.includes('en-us') && (languages.includes('zh-cn') || languages.includes('zh-tw'))
}

function formatOcrPages(pages: OcrPageResult[], totalPages: number, format: 'markdown' | 'text') {
  return pages
    .map((entry) => {
      if (totalPages <= 1) return entry.text.trim()
      const heading = format === 'markdown' ? `## Page ${entry.page}` : `===== Page ${entry.page} =====`
      return `${heading}\n\n${entry.text.trim()}`
    })
    .join('\n\n')
    .trim()
}

interface OutputBufferOptions {
  format: SupportedFileFormat
  title: string
  content: string
  rows: string[][]
  workbook?: WorkbookInput
  slides: NormalizedSlide[]
  assets: Map<string, LoadedImageAsset>
  style?: ResolvedDocumentStyle
  referenceProfile?: PptxStyleReferenceProfile
}

interface NormalizedSlide {
  title: string
  subtitle?: string
  layout: PptxSlideLayout
  takeaway?: string
  visual?: string
  accent: PptxAccent
  accentExplicit?: boolean
  bullets: string[]
  notes?: string
  imageAssetId?: string
  preserveContent?: boolean
  templateSlideNumber?: number
  targetSlideNumber?: number
  referencePattern?: PptxReferenceSlidePattern
}

type PptxSlideLayout =
  | 'cover'
  | 'agenda'
  | 'section'
  | 'insight'
  | 'cards'
  | 'process'
  | 'timeline'
  | 'network'
  | 'matrix'
  | 'schedule'
  | 'route'
  | 'comparison'
  | 'metric'
  | 'chart'
  | 'image'
  | 'quote'
  | 'summary'
type PptxAccent = 'blue' | 'green' | 'amber' | 'purple' | 'cyan' | 'coral' | 'red' | 'slate'

class AssistantServer {
  public mcpServer: McpServer
  private allowedRoots: string[]

  constructor(allowedRoots: string[] = []) {
    this.allowedRoots = normalizeAllowedRoots(allowedRoots)
    this.mcpServer = new McpServer(
      {
        name: 'assistant',
        version: '1.0.0'
      },
      {
        capabilities: {
          tools: {}
        }
      }
    )
    this.setupHandlers()
  }

  private setupHandlers() {
    this.mcpServer.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        NAVIGATE_TOOL,
        DIAGNOSE_TOOL,
        INSPECT_PPTX_TEMPLATE_TOOL,
        CREATE_FILE_TOOL,
        PYTHON_EXECUTE_TOOL,
        OCR_FILE_TOOL
      ]
    }))

    this.mcpServer.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name
      const args = request.params.arguments ?? {}

      try {
        switch (toolName) {
          case 'navigate':
            return await this.navigate(args as Record<string, string | Record<string, string> | undefined>)
          case 'diagnose':
            return await this.diagnose(args)
          case 'inspect_pptx_template':
            return await this.inspectPptxTemplate(args)
          case 'create_file':
            return await this.createFile(args as CreateFileArgs)
          case 'python_execute':
            return await this.executePython(args as PythonExecuteArgs)
          case 'ocr_file':
            return await this.ocrFile(args as OcrFileArgs)
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error(`Tool error: ${toolName}`, { error: message })
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true
        }
      }
    })
  }

  private async navigate(args: Record<string, string | Record<string, string> | undefined>) {
    const targetPath = args.path as string | undefined
    if (!targetPath) throw new McpError(ErrorCode.InvalidParams, "'path' is required for navigate")

    const normalizedPath = targetPath.startsWith('/') ? targetPath : `/${targetPath}`

    if (!ALLOWED_ROUTES.some((route) => normalizedPath === route || normalizedPath.startsWith(route))) {
      throw new McpError(ErrorCode.InvalidParams, `Blocked navigation to disallowed route: ${normalizedPath}`)
    }

    // Serialize query params if provided
    const queryObj = args.query as Record<string, string> | undefined
    let fullPath = normalizedPath
    if (queryObj && typeof queryObj === 'object') {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(queryObj)) {
        if (typeof value === 'string') {
          params.set(key, value)
        }
      }
      const qs = params.toString()
      if (qs) {
        fullPath = `${normalizedPath}?${qs}`
      }
    }

    // Don't actually navigate here 鈥?the renderer will show a clickable button
    // that the user can click to navigate. This keeps the tool non-blocking.
    logger.info('Navigate tool called (deferred to user click)', { path: fullPath })
    return {
      content: [{ type: 'text' as const, text: `Navigate link created: ${fullPath}` }]
    }
  }

  private async diagnose(args: Record<string, unknown>) {
    const action = args.action as string
    if (!action) throw new McpError(ErrorCode.InvalidParams, "'action' is required for diagnose")

    switch (action) {
      case 'info':
        return this.diagnoseInfo()
      case 'providers':
        return await this.diagnoseProviders()
      case 'health':
        return await this.diagnoseHealth(args.provider_id as string | undefined)
      case 'logs':
        return this.diagnoseLogs(args.lines as number | undefined)
      case 'errors':
        return this.diagnoseErrors(args.lines as number | undefined)
      case 'mcp_status':
        return await this.diagnoseMcpStatus()
      case 'read_source':
        return this.readSource(args.file_path as string | undefined, args.lines as number | undefined)
      case 'config':
        return await this.diagnoseConfig()
      case 'python':
        return await this.diagnosePython()
      default:
        throw new McpError(ErrorCode.InvalidParams, `Unknown diagnose action: ${action}`)
    }
  }

  private async createFile(args: CreateFileArgs) {
    const filePath = typeof args.file_path === 'string' ? args.file_path.trim() : ''
    if (!filePath) throw new McpError(ErrorCode.InvalidParams, "'file_path' is required for create_file")

    const format = normalizeFormat(args.format, filePath)
    const outputPath = this.resolveOutputPath(filePath)
    const title =
      typeof args.title === 'string' && args.title.trim()
        ? args.title.trim()
        : path.basename(outputPath, path.extname(outputPath))
    const content = typeof args.content === 'string' ? args.content : ''
    const styleContent = [
      content,
      ...(Array.isArray(args.slides)
        ? args.slides.flatMap((slide) => [slide.title, slide.subtitle, slide.takeaway, ...(slide.bullets || [])])
        : [])
    ]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n')
    const referenceInput = args.pptx_style_reference
    const templateInput = args.pptx_template
    const templateMode = templateInput?.mode || 'edit-copy'
    const adaptiveTemplate = templateMode === 'adaptive-design'
    if (referenceInput && templateInput) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Use either pptx_style_reference for approximate style guidance or pptx_template for native template reuse, not both'
      )
    }
    if (referenceInput && format !== 'pptx') {
      throw new McpError(ErrorCode.InvalidParams, 'pptx_style_reference is only supported for PPTX output')
    }
    if (templateInput && format !== 'pptx') {
      throw new McpError(ErrorCode.InvalidParams, 'pptx_template is only supported for PPTX output')
    }
    if (adaptiveTemplate && (templateInput?.shape_replacements?.length || templateInput?.target_slide_number)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'adaptive-design creates new content-fit pages and cannot use target_slide_number or shape_replacements'
      )
    }
    let referenceProfile: PptxStyleReferenceProfile | undefined
    if (referenceInput) {
      const referencePathValue = typeof referenceInput.file_path === 'string' ? referenceInput.file_path.trim() : ''
      if (!referencePathValue) {
        throw new McpError(ErrorCode.InvalidParams, "'pptx_style_reference.file_path' is required")
      }
      const referencePath = this.resolveInputPath(referencePathValue)
      try {
        referenceProfile = await analyzePptxStyleReference(referencePath, referenceInput.slide_number)
      } catch (error) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Unable to analyze PPT style reference: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    let templatePath: string | undefined
    let templateBuffer: Buffer | undefined
    let templateProfile: PptxStyleReferenceProfile | undefined
    if (templateInput) {
      const templatePathValue = typeof templateInput.file_path === 'string' ? templateInput.file_path.trim() : ''
      if (!templatePathValue) {
        throw new McpError(ErrorCode.InvalidParams, "'pptx_template.file_path' is required")
      }
      templatePath = this.resolveInputPath(templatePathValue)
      if (path.extname(templatePath).toLowerCase() !== '.pptx') {
        throw new McpError(ErrorCode.InvalidParams, 'pptx_template.file_path must point to a .pptx file')
      }
      if (path.resolve(templatePath).toLowerCase() === path.resolve(outputPath).toLowerCase()) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'pptx_template output must use a different path from the source PPTX'
        )
      }
      const stat = await fsp.stat(templatePath)
      if (!stat.isFile()) throw new McpError(ErrorCode.InvalidParams, 'pptx_template reference is not a file')
      if (stat.size > 100 * 1024 * 1024) {
        throw new McpError(ErrorCode.InvalidParams, 'pptx_template reference exceeds the 100 MB limit')
      }
      templateBuffer = await fsp.readFile(templatePath)
      if (templateMode === 'new-deck' || adaptiveTemplate) {
        try {
          templateProfile = analyzePptxBuffer(templateBuffer, templatePath)
          if (adaptiveTemplate) referenceProfile = templateProfile
        } catch (error) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Unable to inspect native PPTX template composition: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    }
    const requestedStyleMode =
      args.style_mode && args.style_mode !== 'auto'
        ? args.style_mode
        : referenceProfile?.suggestedMode || args.style_mode
    let documentStyle =
      (format === 'docx' || format === 'pptx' || format === 'pdf') && (!templateInput || adaptiveTemplate)
        ? resolveDocumentStyle({
            visualStyle: referenceProfile?.suggestedVisualStyle || args.visual_style,
            styleMode: requestedStyleMode,
            documentType: args.document_type,
            title,
            content: styleContent,
            format,
            brandTheme: referenceProfile ? referenceBrandTheme(referenceProfile, args.brand_theme) : args.brand_theme
          })
        : undefined
    if (documentStyle && referenceProfile) {
      documentStyle = applyPptxReferenceFonts(documentStyle, referenceProfile, false)
    }
    const hasExplicitRows = Array.isArray(args.rows) && args.rows.length > 0
    const rows = hasExplicitRows || format === 'csv' || format === 'xlsx' ? normalizeRows(args.rows, content) : []
    const workbook = args.workbook && typeof args.workbook === 'object' ? args.workbook : undefined
    const assets = await loadImageAssets(args.assets, (assetPath) => this.resolveInputPath(assetPath))
    if (assets.size > 0 && !['docx', 'pptx', 'pdf'].includes(format)) {
      throw new McpError(ErrorCode.InvalidParams, `Image assets are not supported for ${format.toUpperCase()} output`)
    }
    const slides = templateInput && !Array.isArray(args.slides) ? [] : normalizeSlides(args.slides, title, content)
    if (templateInput && templateProfile && !adaptiveTemplate) {
      validateNativeTemplateImageReplacements(templateInput, templateProfile, slides)
    }
    const assetUsage = validateImageAssetUsage(
      assets,
      format === 'docx' || format === 'pdf' ? content : '',
      format === 'pptx' ? slides.map((slide) => slide.imageAssetId) : []
    )
    const usedAssets = new Map(assetUsage.usedAssetIds.map((id) => [id, assets.get(id)!]))
    if (
      referenceProfile &&
      isImageHeavyPptxReference(referenceProfile) &&
      !slides.some((slide) => slide.imageAssetId)
    ) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'The supplied PPTX style reference is image-heavy, but no output slide uses an image. Add topic-relevant local images through assets and assign image_asset_id to the corresponding slides; do not reuse unrelated reference photos or submit a text-only approximation.'
      )
    }
    const referenceImageDiversity = referenceProfile
      ? validateReferenceImageDiversity(referenceProfile, slides, usedAssets)
      : undefined
    let templateSummary: PptxTemplateSummary | undefined
    let buffer: Buffer
    if (templateInput && !adaptiveTemplate) {
      const generated = await createPptxFromTemplate(templateBuffer!, templatePath!, slides, templateInput, usedAssets)
      templateSummary = generated.summary
      buffer = generated.buffer
    } else {
      buffer = await createOutputBuffer({
        format,
        title,
        content,
        rows,
        workbook,
        slides,
        assets: usedAssets,
        style: documentStyle,
        referenceProfile
      })
    }
    const verification = await verifyGeneratedOutput({
      format,
      buffer,
      expectedSlides: format === 'pptx' ? templateSummary?.outputSlides || slides.length : undefined,
      expectedMediaAssets: usedAssets.size,
      renderValidation: args.render_validation
    })
    if (referenceProfile?.kind === 'pptx') {
      const outputProfile = analyzePptxBuffer(buffer, path.basename(outputPath))
      const similarity = comparePptxReferenceComposition(
        referenceProfile,
        outputProfile,
        slides.map((slide) => slide.layout)
      )
      if (similarity.errors.length) {
        throw new Error(`Generated PPTX failed reference-composition validation: ${similarity.errors.join('; ')}`)
      }
      verification.checks.push('pptx-reference-composition')
      verification.warnings.push(...similarity.warnings)
      Object.assign(verification.details, similarity.details)
    } else if (referenceProfile?.kind === 'image') {
      const outputProfile = analyzePptxBuffer(buffer, path.basename(outputPath))
      const similarity = comparePptxReferenceDesignLanguage(referenceProfile, outputProfile)
      verification.checks.push('pptx-reference-design-language')
      verification.warnings.push(...similarity.warnings)
      Object.assign(verification.details, similarity.details)
    }
    if (assetUsage.unusedAssetIds.length > 0) {
      verification.warnings.push(`Unused image assets: ${assetUsage.unusedAssetIds.join(', ')}`)
    }
    verification.details.referenced_image_assets = usedAssets.size
    verification.details.unused_image_assets = assetUsage.unusedAssetIds.length
    if (referenceImageDiversity) {
      verification.details.reference_image_slide_assignments = referenceImageDiversity.assignments
      verification.details.reference_unique_image_media = referenceImageDiversity.uniqueMedia
      verification.details.reference_dominant_image_reuse_ratio = referenceImageDiversity.dominantReuseRatio
    }
    if (documentStyle) {
      verification.details.visual_style = documentStyle.id
      verification.details.visual_style_label = documentStyle.label
      verification.details.visual_style_source = documentStyle.source
      verification.details.style_mode = documentStyle.mode
      verification.details.document_type = args.document_type?.trim() || 'auto'
    }
    if (referenceProfile) {
      verification.warnings.push(...referenceProfile.warnings)
      if (args.visual_style && args.visual_style !== referenceProfile.suggestedVisualStyle) {
        verification.warnings.push(
          `visual_style '${args.visual_style}' was ignored because pptx_style_reference leads the layout language; resolved '${referenceProfile.suggestedVisualStyle}' from the reference.`
        )
      }
      verification.details.style_reference_kind = referenceProfile.kind
      verification.details.style_reference_slide = referenceProfile.analyzedSlide || 0
      verification.details.style_reference_confidence = referenceProfile.layoutConfidence
      verification.details.style_reference_aspect_ratio = referenceProfile.aspectRatio
      verification.details.style_reference_aspect_compatible = referenceProfile.aspectRatioCompatible
      verification.details.style_reference_picture_slide_ratio = referenceProfile.metrics.pictureSlideRatio
      verification.details.style_reference_picture_coverage = referenceProfile.metrics.averagePictureCoverage
      verification.details.style_reference_chart_slide_ratio = referenceProfile.metrics.chartSlideRatio
      verification.details.style_reference_native_layouts = referenceProfile.metrics.nativeLayoutCount
      verification.details.style_reference_visual_layout_diversity = referenceProfile.metrics.visualLayoutDiversityRatio
      verification.details.style_reference_design_language = JSON.stringify(referenceProfile.designLanguage)
      if (adaptiveTemplate) {
        verification.details.pptx_template_mode = 'adaptive-design'
        verification.details.pptx_template_source_path = templatePath || ''
        verification.details.pptx_template_exact_package_reuse = false
      }
    }
    if (templateSummary) {
      verification.warnings.push(...templateSummary.warnings)
      verification.details.pptx_template_mode = templateSummary.mode
      verification.details.pptx_template_source_slides = templateSummary.sourceSlides
      verification.details.pptx_template_output_slides = templateSummary.outputSlides
      verification.details.pptx_template_edited_slides = templateSummary.editedSlides.join(',')
      verification.details.pptx_template_cloned_slides = templateSummary.clonedSlides.join(',')
      verification.details.pptx_template_masters_preserved = templateSummary.mastersPreserved
      verification.details.pptx_template_layouts_preserved = templateSummary.layoutsPreserved
      verification.details.pptx_template_media_preserved = templateSummary.mediaPreserved
      verification.details.pptx_template_exact_package_reuse = templateSummary.exactPackageReuse
    }
    await fsp.mkdir(path.dirname(outputPath), { recursive: true })
    await fsp.writeFile(outputPath, buffer)

    const stat = await fsp.stat(outputPath)
    logger.info('Assistant create_file generated output', {
      path: outputPath,
      format,
      size: stat.size
    })

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              status: 'created',
              path: outputPath,
              format,
              size: stat.size,
              verified: stat.isFile() && stat.size > 0 && verification.passed,
              render_verified: verification.details.render_verification === 'passed',
              render_verification: verification.details.render_verification ?? 'not_applicable',
              visual_style: documentStyle?.id,
              visual_style_label: documentStyle?.label,
              visual_style_source: documentStyle?.source,
              style_mode: documentStyle?.mode,
              document_type: documentStyle ? args.document_type?.trim() || 'auto' : undefined,
              pptx_style_reference: referenceProfile ? pptxReferenceSummary(referenceProfile) : undefined,
              pptx_template: templateSummary ? pptxTemplateSummary(templateSummary) : undefined,
              pptx_template_strategy: adaptiveTemplate ? 'adaptive-design' : templateSummary?.mode,
              verification
            },
            null,
            2
          )
        }
      ]
    }
  }

  private async inspectPptxTemplate(args: Record<string, unknown>) {
    const filePathValue = typeof args.file_path === 'string' ? args.file_path.trim() : ''
    if (!filePathValue) throw new McpError(ErrorCode.InvalidParams, "'file_path' is required")
    const templatePath = this.resolveInputPath(filePathValue)
    if (path.extname(templatePath).toLowerCase() !== '.pptx') {
      throw new McpError(ErrorCode.InvalidParams, 'file_path must point to a .pptx file')
    }
    const stat = await fsp.stat(templatePath)
    if (!stat.isFile()) throw new McpError(ErrorCode.InvalidParams, 'PPTX template is not a file')
    if (stat.size > 100 * 1024 * 1024) {
      throw new McpError(ErrorCode.InvalidParams, 'PPTX template exceeds the 100 MB limit')
    }

    const templateBuffer = await fsp.readFile(templatePath)
    const profiles = profilePptxTemplateSlides(templateBuffer)
    const styleProfile = analyzePptxBuffer(templateBuffer, templatePath)
    const designLanguage = styleProfile.designLanguage
    const payload = {
      source_path: templatePath,
      slide_count: profiles.length,
      planning_rule:
        'Plan the new-topic storyline independently, then preserve the source design language rather than its old content sequence. Reuse a source page only when its semantic structure fits; otherwise choose a better source page or use the closest supported composition. Keep item counts within capacity and body copy inside the reported density range. Photo pages require a topic-relevant image_asset_id. Native charts require numeric label:value items. Never copy source-topic text, icons, pictures, or force sequential page mapping.',
      design_language: {
        palette_strategy: designLanguage.paletteStrategy,
        contrast: designLanguage.contrast,
        typography_scale: designLanguage.typographyScale,
        alignment: designLanguage.alignment,
        shape_language: designLanguage.shapeLanguage,
        content_density: designLanguage.contentDensity,
        image_treatment: designLanguage.imageTreatment,
        page_rhythm: designLanguage.pageRhythm,
        heading_font: styleProfile.headingFont,
        body_font: styleProfile.bodyFont,
        east_asia_font: styleProfile.eastAsiaFont,
        primary_color: styleProfile.primaryColor,
        secondary_color: styleProfile.secondaryColor,
        accent_color: styleProfile.accentColor,
        background_color: styleProfile.backgroundColor
      },
      deck_targets: {
        minimum_text_density_ratio: designLanguage.targets.minimumTextDensityRatio,
        maximum_text_density_ratio: designLanguage.targets.maximumTextDensityRatio,
        minimum_layout_diversity_ratio: designLanguage.targets.minimumLayoutDiversityRatio,
        picture_slide_ratio: designLanguage.targets.pictureSlideRatio,
        chart_slide_ratio: designLanguage.targets.chartSlideRatio,
        dark_slide_ratio: designLanguage.targets.darkSlideRatio
      },
      pages: profiles.map((profile) => ({
        slide_number: profile.slideNumber,
        archetype: profile.kind,
        item_capacity: profile.itemCapacity,
        arrangement: profile.arrangement,
        content_density: profile.contentDensity,
        source_text_units: profile.sourceTextUnits,
        source_body_text_units: profile.sourceBodyTextUnits,
        target_body_text_units_min: profile.targetBodyTextUnitsMin,
        target_body_text_units_max: profile.targetBodyTextUnitsMax,
        editable_text_blocks: profile.editableTextBlocks,
        preferred_detail_pattern:
          profile.contentDensity === 'dense'
            ? 'heading | evidence + interpretation + implication/action'
            : profile.contentDensity === 'balanced'
              ? 'heading | concise evidence + implication'
              : 'headline or metric | short explanation',
        requires_topic_image: profile.hasPicture,
        has_native_chart: profile.hasChart,
        chart_kind: profile.chartKind,
        has_native_table: profile.hasTable,
        metric_layout: profile.metricLike
      }))
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
  }

  private async executePython(args: PythonExecuteArgs) {
    const code = typeof args.code === 'string' ? args.code : ''
    const scriptPathValue = typeof args.script_path === 'string' ? args.script_path.trim() : ''
    if (Boolean(code.trim()) === Boolean(scriptPathValue)) {
      throw new McpError(ErrorCode.InvalidParams, "Provide exactly one of 'code' or 'script_path'")
    }

    const scriptPath = scriptPathValue ? this.resolveInputPath(scriptPathValue) : undefined
    if (scriptPath && path.extname(scriptPath).toLowerCase() !== '.py') {
      throw new McpError(ErrorCode.InvalidParams, "'script_path' must point to a .py file")
    }

    const cwd = args.working_directory
      ? this.resolveInputPath(args.working_directory, { requireDirectory: true })
      : scriptPath
        ? path.dirname(scriptPath)
        : this.allowedRoots[0]
    if (!cwd) throw new McpError(ErrorCode.InvalidParams, 'No allowed working directory is available')

    const result = scriptPath
      ? await managedPythonService.executeScript(scriptPath, args.arguments ?? [], {
          cwd,
          timeoutMs: args.timeout_ms
        })
      : await managedPythonService.execute(code, {
          cwd,
          timeoutMs: args.timeout_ms
        })
    const payload = {
      status: result.exitCode === 0 ? 'completed' : 'failed',
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      duration_ms: result.durationMs,
      working_directory: cwd,
      mode: scriptPath ? 'script' : 'inline',
      script_path: scriptPath
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
      ...(result.exitCode === 0 ? {} : { isError: true })
    }
  }

  private async ocrFile(args: OcrFileArgs) {
    const filePath = typeof args.file_path === 'string' ? args.file_path.trim() : ''
    if (!filePath) throw new McpError(ErrorCode.InvalidParams, "'file_path' is required for ocr_file")

    const inputPath = this.resolveInputPath(filePath)
    const stat = await fsp.stat(inputPath)
    if (!stat.isFile()) throw new McpError(ErrorCode.InvalidParams, `OCR input is not a file: ${inputPath}`)
    if (stat.size > 100 * 1024 * 1024) {
      throw new McpError(ErrorCode.InvalidParams, 'OCR input exceeds the 100MB limit')
    }

    const extension = path.extname(inputPath).toLowerCase()
    const provider = args.provider ?? 'auto'
    const languages: NonNullable<OcrFileArgs['languages']> = args.languages?.length
      ? args.languages
      : ['zh-cn', 'en-us']
    let pages: OcrPageResult[]
    let totalPages = 1
    let limited = false

    if (extension === '.pdf') {
      const result = await this.ocrPdf(inputPath, provider, languages, args.pages, args.max_pages)
      pages = result.pages
      totalPages = result.totalPages
      limited = result.limited
    } else if (SUPPORTED_OCR_IMAGE_EXTENSIONS.has(extension)) {
      const result = await this.ocrImage(inputPath, provider, languages)
      pages = [
        {
          page: 1,
          provider: result.provider,
          text: result.text,
          quality: result.quality,
          candidateCount: result.candidateCount,
          confidence: result.confidence
        }
      ]
    } else {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unsupported OCR file type: ${extension || '(none)'}. Use an image or PDF.`
      )
    }

    const responseFullText = formatOcrPages(pages, totalPages, 'markdown')
    let outputPath: string | undefined

    if (args.output_path) {
      outputPath = this.resolveOutputPath(args.output_path)
      const outputExtension = path.extname(outputPath).toLowerCase()
      if (!['.txt', '.md'].includes(outputExtension)) {
        throw new McpError(ErrorCode.InvalidParams, "'output_path' must end with .txt or .md")
      }
      await fsp.mkdir(path.dirname(outputPath), { recursive: true })
      const outputText = formatOcrPages(pages, totalPages, outputExtension === '.md' ? 'markdown' : 'text')
      await fsp.writeFile(outputPath, outputText, 'utf8')
    }

    const responseText =
      responseFullText.length > MAX_OCR_RESPONSE_CHARS
        ? responseFullText.slice(0, MAX_OCR_RESPONSE_CHARS)
        : responseFullText
    const lowConfidencePages = pages.filter((entry) => entry.quality.shouldFallback).map((entry) => entry.page)
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              status: lowConfidencePages.length > 0 ? 'completed_with_warnings' : 'completed',
              input_path: inputPath,
              output_path: outputPath,
              total_pages: totalPages,
              processed_pages: pages.map((entry) => entry.page),
              providers: [...new Set(pages.map((entry) => entry.provider))],
              requested_languages: languages,
              page_results: pages.map((entry) => ({
                page: entry.page,
                provider: entry.provider,
                quality_score: entry.quality.score,
                engine_confidence: entry.confidence,
                candidate_count: entry.candidateCount,
                low_confidence: entry.quality.shouldFallback
              })),
              low_confidence_pages: lowConfidencePages,
              warning:
                lowConfidencePages.length > 0
                  ? `OCR quality is uncertain on page(s): ${lowConfidencePages.join(', ')}. Verify names, numbers, dates, and missing text against the source image.`
                  : undefined,
              limited,
              response_truncated: responseText.length < responseFullText.length,
              character_count: responseFullText.length,
              text: responseText
            },
            null,
            2
          )
        }
      ]
    }
  }

  private async ocrPdf(
    filePath: string,
    provider: NonNullable<OcrFileArgs['provider']>,
    languages: NonNullable<OcrFileArgs['languages']>,
    requestedPages?: number[],
    requestedMaxPages?: number
  ): Promise<{ pages: OcrPageResult[]; totalPages: number; limited: boolean }> {
    const maxPages = Math.min(Math.max(Math.round(requestedMaxPages ?? 20), 1), 50)
    const data = await fsp.readFile(filePath)
    const parser = new PDFParse({ data })
    const tempDir = await fsp.mkdtemp(path.join(app.getPath('temp'), 'zen-ocr-'))

    try {
      const info = await parser.getInfo()
      const totalPages = info.total
      const selectedPages = requestedPages?.length
        ? [...new Set(requestedPages.map((page) => Math.round(page)))].filter((page) => page >= 1 && page <= totalPages)
        : Array.from({ length: Math.min(totalPages, maxPages) }, (_, index) => index + 1)

      if (selectedPages.length === 0) {
        throw new McpError(ErrorCode.InvalidParams, 'No valid PDF pages were selected for OCR')
      }
      if (selectedPages.length > maxPages) {
        throw new McpError(ErrorCode.InvalidParams, `Selected ${selectedPages.length} pages; max_pages is ${maxPages}`)
      }

      const screenshots = await parser.getScreenshot({
        partial: selectedPages,
        desiredWidth: 1800,
        imageBuffer: true,
        imageDataUrl: false
      })
      const pages: OcrPageResult[] = []

      for (const screenshot of screenshots.pages) {
        const pagePath = path.join(tempDir, `page-${screenshot.pageNumber}.png`)
        await fsp.writeFile(pagePath, screenshot.data)
        const result = await this.ocrImage(pagePath, provider, languages)
        pages.push({
          page: screenshot.pageNumber,
          provider: result.provider,
          text: result.text,
          quality: result.quality,
          candidateCount: result.candidateCount,
          confidence: result.confidence
        })
      }

      return {
        pages,
        totalPages,
        limited: selectedPages.length < totalPages
      }
    } finally {
      await parser.destroy().catch(() => undefined)
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async ocrImage(
    filePath: string,
    provider: NonNullable<OcrFileArgs['provider']>,
    languages: NonNullable<OcrFileArgs['languages']>
  ): Promise<{
    provider: string
    text: string
    quality: OcrTextQuality
    candidateCount: number
    confidence?: number
  }> {
    const stat = await fsp.stat(filePath)
    const metadata: ImageFileMetadata = {
      id: randomUUID(),
      name: path.basename(filePath),
      origin_name: path.basename(filePath),
      path: filePath,
      size: stat.size,
      ext: path.extname(filePath).toLowerCase(),
      type: FILE_TYPE.IMAGE,
      created_at: stat.birthtime.toISOString(),
      count: 1
    }
    const availableProviders = new Set(ocrService.listProviderIds())
    const errors: string[] = []
    const candidates: OcrCandidate[] = []

    const runCandidate = async (
      providerId: 'system' | 'tesseract',
      label: string = providerId,
      preprocess: 'auto' | 'high-contrast' = 'auto'
    ) => {
      if (!availableProviders.has(providerId)) {
        errors.push(`${label}: provider unavailable`)
        return undefined
      }
      try {
        const ocrProvider = createAssistantOcrProvider(providerId, languages, preprocess)
        const result = await ocrService.ocr(metadata, ocrProvider)
        const text = formatOcrResult(result)
        if (!text) {
          errors.push(`${label}: empty result`)
          return undefined
        }

        const candidate: OcrCandidate = {
          provider: providerId,
          label,
          text,
          quality: assessOcrCandidateQuality(text, languages, result.confidence),
          confidence: result.confidence
        }
        candidates.push(candidate)
        return candidate
      } catch (error) {
        errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    }

    if (provider !== 'auto') {
      const requestedProvider = provider === 'system' ? BuiltinOcrProviderIds.system : BuiltinOcrProviderIds.tesseract
      const candidate = await runCandidate(requestedProvider)
      if (candidate) {
        return {
          provider: candidate.label,
          text: candidate.text,
          quality: candidate.quality,
          candidateCount: 1,
          confidence: candidate.confidence
        }
      }
      throw new Error(`OCR failed. ${errors.join('; ') || 'The requested OCR provider is unavailable.'}`)
    }

    const systemCandidate = await runCandidate(BuiltinOcrProviderIds.system)
    const compareEngines = shouldCompareOcrEngines(languages)
    if (!systemCandidate || compareEngines || systemCandidate.quality.shouldFallback) {
      await runCandidate(BuiltinOcrProviderIds.tesseract)
    }

    if (candidates.length > 0 && candidates.every((candidate) => candidate.quality.shouldFallback)) {
      await runCandidate(BuiltinOcrProviderIds.tesseract, 'tesseract-high-contrast', 'high-contrast')
    }

    if (candidates.length > 0) {
      const selected = chooseBestOcrCandidateV2(candidates)
      logger.debug('Selected OCR result after quality fallback', {
        selected: selected.label,
        candidates: candidates.map((candidate) => ({
          provider: candidate.label,
          confidence: candidate.confidence,
          ...candidate.quality
        }))
      })
      return {
        provider: selected.label,
        text: selected.text,
        quality: selected.quality,
        candidateCount: candidates.length,
        confidence: selected.confidence
      }
    }

    throw new Error(`OCR failed. ${errors.join('; ') || 'No requested OCR provider is available.'}`)
  }

  private resolveOutputPath(filePath: string) {
    const rawPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.allowedRoots[0] ?? app.getPath('documents'), filePath)
    const resolved = path.resolve(rawPath)

    if (!this.allowedRoots.some((root) => isPathInside(resolved, root))) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Access denied: output path must be inside an allowed workspace/user folder. Allowed roots: ${this.allowedRoots.join(', ')}`
      )
    }

    return resolved
  }

  private resolveInputPath(filePath: string, options?: { requireDirectory?: boolean }) {
    const rawPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.allowedRoots[0] ?? app.getPath('documents'), filePath)
    const resolved = path.resolve(rawPath)

    if (!this.allowedRoots.some((root) => isPathInside(resolved, root))) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Access denied: input path must be inside an allowed workspace/user folder. Allowed roots: ${this.allowedRoots.join(', ')}`
      )
    }
    let canonicalPath = resolved
    try {
      canonicalPath = fs.realpathSync.native(resolved)
    } catch {
      if (options?.requireDirectory) {
        throw new McpError(ErrorCode.InvalidParams, `Working directory does not exist: ${resolved}`)
      }
    }
    const canonicalRoots = this.allowedRoots.map((root) => {
      try {
        return fs.realpathSync.native(root)
      } catch {
        return root
      }
    })
    if (!canonicalRoots.some((root) => isPathInside(canonicalPath, root))) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Access denied: input resolves outside an allowed workspace/user folder. Allowed roots: ${this.allowedRoots.join(', ')}`
      )
    }
    if (options?.requireDirectory && !fs.statSync(canonicalPath, { throwIfNoEntry: false })?.isDirectory()) {
      throw new McpError(ErrorCode.InvalidParams, `Working directory does not exist: ${canonicalPath}`)
    }

    return canonicalPath
  }

  private async diagnosePython() {
    const status = await managedPythonService.getStatus()
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }]
    }
  }

  private diagnoseInfo() {
    const info = {
      app: {
        version: app.getVersion(),
        name: app.getName(),
        isPackaged: app.isPackaged,
        locale: app.getLocale()
      },
      paths: {
        userData: app.getPath('userData'),
        logs: app.getPath('logs'),
        temp: app.getPath('temp')
      },
      runtime: {
        node: process.versions.node,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        v8: process.versions.v8
      },
      system: {
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        totalMemory: `${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`,
        freeMemory: `${Math.round(os.freemem() / 1024 / 1024 / 1024)}GB`,
        cpus: os.cpus().length,
        hostname: os.hostname()
      }
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }]
    }
  }

  private async diagnoseProviders() {
    try {
      const { configManager } = await import('@main/services/ConfigManager')
      const providers = configManager.get<unknown[]>('providers', [])

      const summary = (providers as Record<string, unknown>[]).map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        apiHost: p.apiHost || p.anthropicApiHost || '(default)',
        hasApiKey: !!(p.apiKey && typeof p.apiKey === 'string' && p.apiKey.length > 0),
        enabled: p.enabled !== false,
        modelCount: Array.isArray(p.models) ? p.models.length : 0
      }))

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ providerCount: summary.length, providers: summary }, null, 2)
          }
        ]
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to read provider config: ${error instanceof Error ? error.message : String(error)}`
          }
        ],
        isError: true
      }
    }
  }

  private async diagnoseHealth(providerId?: string) {
    if (!providerId) {
      throw new McpError(ErrorCode.InvalidParams, "'provider_id' is required for health action")
    }

    // Check cache first (30s TTL)
    const cached = healthCache.get(providerId)
    if (cached && Date.now() - cached.timestamp < HEALTH_CACHE_TTL) {
      return cached.result as ReturnType<typeof this.diagnoseHealth>
    }

    try {
      const { configManager } = await import('@main/services/ConfigManager')
      const providers = configManager.get<unknown[]>('providers', []) as Record<string, unknown>[]
      const provider = providers.find((p) => p.id === providerId)

      if (!provider) {
        return {
          content: [{ type: 'text' as const, text: `Provider not found: ${providerId}` }],
          isError: true
        }
      }

      const apiKey = provider.apiKey as string | undefined
      const apiHost = (provider.apiHost || provider.anthropicApiHost || '') as string

      if (!apiKey) {
        const result = {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  providerId,
                  status: 'error',
                  error: 'No API key configured'
                },
                null,
                2
              )
            }
          ]
        }
        healthCache.set(providerId, { result, timestamp: Date.now() })
        return result
      }

      // Simple connectivity test 鈥?try to reach the API host
      const startTime = Date.now()
      try {
        const testUrl = apiHost.startsWith('http') ? apiHost : `https://${apiHost}`
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 10000)
        const response = await fetch(testUrl, {
          method: 'HEAD',
          signal: controller.signal
        })
        clearTimeout(timeout)
        const latency = Date.now() - startTime

        const result = {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  providerId,
                  status: response.ok || response.status === 401 || response.status === 403 ? 'reachable' : 'error',
                  httpStatus: response.status,
                  latencyMs: latency,
                  host: testUrl
                },
                null,
                2
              )
            }
          ]
        }
        healthCache.set(providerId, { result, timestamp: Date.now() })
        return result
      } catch (fetchError) {
        const latency = Date.now() - startTime
        const result = {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  providerId,
                  status: 'unreachable',
                  error: fetchError instanceof Error ? fetchError.message : String(fetchError),
                  latencyMs: latency,
                  host: apiHost || '(no host configured)'
                },
                null,
                2
              )
            }
          ]
        }
        healthCache.set(providerId, { result, timestamp: Date.now() })
        return result
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Health check failed: ${error instanceof Error ? error.message : String(error)}`
          }
        ],
        isError: true
      }
    }
  }

  private diagnoseLogs(requestedLines?: number) {
    const maxLines = 500
    const lines = Math.min(Math.max(requestedLines || 50, 1), maxLines)

    try {
      const logsDir = app.getPath('logs')
      if (!fs.existsSync(logsDir)) {
        return {
          content: [{ type: 'text' as const, text: `Logs directory not found: ${logsDir}` }],
          isError: true
        }
      }

      // Find the most recent .log file
      const logFiles = fs
        .readdirSync(logsDir)
        .filter((f) => f.endsWith('.log'))
        .map((f) => ({
          name: f,
          mtime: fs.statSync(path.join(logsDir, f)).mtime.getTime()
        }))
        .sort((a, b) => b.mtime - a.mtime)

      if (logFiles.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No log files found' }],
          isError: true
        }
      }

      const latestLog = logFiles[0]
      const logPath = path.join(logsDir, latestLog.name)
      const content = fs.readFileSync(logPath, 'utf-8')
      const allLines = content.split('\n')
      const tailLines = allLines.slice(-lines).join('\n')

      return {
        content: [
          {
            type: 'text' as const,
            text: `=== ${latestLog.name} (last ${lines} lines) ===\n${tailLines}`
          }
        ]
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to read logs: ${error instanceof Error ? error.message : String(error)}`
          }
        ],
        isError: true
      }
    }
  }

  private diagnoseErrors(requestedLines?: number) {
    const maxEntries = 200
    const limit = Math.min(Math.max(requestedLines || 50, 1), maxEntries)

    try {
      const logsDir = app.getPath('logs')
      if (!fs.existsSync(logsDir)) {
        return { content: [{ type: 'text' as const, text: 'Logs directory not found' }], isError: true }
      }

      const logFiles = fs
        .readdirSync(logsDir)
        .filter((f) => f.endsWith('.log'))
        .map((f) => ({ name: f, mtime: fs.statSync(path.join(logsDir, f)).mtime.getTime() }))
        .sort((a, b) => b.mtime - a.mtime)

      if (logFiles.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No log files found' }], isError: true }
      }

      // Scan up to 3 most recent log files for error/warn lines
      const errorLines: string[] = []
      const errorPattern = /\b(ERROR|WARN|error|warn)\b/

      for (const logFile of logFiles.slice(0, 3)) {
        if (errorLines.length >= limit) break
        const content = fs.readFileSync(path.join(logsDir, logFile.name), 'utf-8')
        const lines = content.split('\n')
        for (let i = lines.length - 1; i >= 0 && errorLines.length < limit; i--) {
          if (errorPattern.test(lines[i])) {
            errorLines.push(`[${logFile.name}] ${lines[i]}`)
          }
        }
      }

      if (errorLines.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No ERROR/WARN entries found in recent logs' }] }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `=== ${errorLines.length} error/warn entries ===\n${errorLines.reverse().join('\n')}`
          }
        ]
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to read errors: ${error instanceof Error ? error.message : String(error)}`
          }
        ],
        isError: true
      }
    }
  }

  private async diagnoseMcpStatus() {
    try {
      const { configManager } = await import('@main/services/ConfigManager')
      const mcpServers = configManager.get<unknown[]>('mcpServers', []) as Record<string, unknown>[]

      const summary = mcpServers.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type || 'stdio',
        isActive: s.isActive ?? false,
        command: s.command,
        baseUrl: s.baseUrl
      }))

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ serverCount: summary.length, servers: summary }, null, 2)
          }
        ]
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to read MCP status: ${error instanceof Error ? error.message : String(error)}`
          }
        ],
        isError: true
      }
    }
  }

  private async diagnoseConfig() {
    try {
      const { configManager } = await import('@main/services/ConfigManager')

      // Default model info
      const defaultModel = configManager.get<Record<string, unknown>>('defaultModel', {})
      const topicNamingModel = configManager.get<Record<string, unknown>>('topicNamingModel', {})

      const settings = {
        language: configManager.getLanguage(),
        theme: configManager.getTheme(),
        proxy: configManager.get<string>('proxy', ''),
        zoomFactor: configManager.getZoomFactor(),
        defaultModel: defaultModel
          ? { id: defaultModel.id, name: defaultModel.name, provider: defaultModel.provider }
          : null,
        topicNamingModel: topicNamingModel ? { id: topicNamingModel.id, name: topicNamingModel.name } : null,
        tray: configManager.getTray(),
        trayOnClose: configManager.getTrayOnClose(),
        launchToTray: configManager.getLaunchToTray(),
        autoUpdate: configManager.getAutoUpdate(),
        enableQuickAssistant: configManager.getEnableQuickAssistant(),
        selectionAssistantEnabled: configManager.getSelectionAssistantEnabled(),
        enableDeveloperMode: configManager.getEnableDeveloperMode(),
        disableHardwareAcceleration: configManager.getDisableHardwareAcceleration(),
        useSystemTitleBar: configManager.getUseSystemTitleBar()
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(settings, null, 2)
          }
        ]
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to read config: ${error instanceof Error ? error.message : String(error)}`
          }
        ],
        isError: true
      }
    }
  }

  private readSource(filePath?: string, requestedLines?: number) {
    if (!filePath) {
      throw new McpError(ErrorCode.InvalidParams, "'file_path' is required for read_source action")
    }

    // Resolve against app root (source repo in dev, app.asar in prod)
    const appRoot = app.getAppPath()
    const resolved = path.resolve(appRoot, filePath)

    // Security: only allow reading within app root and node_modules
    const allowedRoots = [appRoot, path.join(appRoot, 'node_modules')]
    if (!allowedRoots.some((root) => resolved.startsWith(root + path.sep) || resolved === root)) {
      throw new McpError(ErrorCode.InvalidParams, `Access denied: path must be within the app directory`)
    }

    // Block sensitive files
    const basename = path.basename(resolved).toLowerCase()
    if (basename === '.env' || basename.endsWith('.env.local') || basename === 'credentials.json') {
      throw new McpError(ErrorCode.InvalidParams, `Access denied: cannot read sensitive files`)
    }

    if (!fs.existsSync(resolved)) {
      return {
        content: [{ type: 'text' as const, text: `File not found: ${filePath}` }],
        isError: true
      }
    }

    const stat = fs.statSync(resolved)
    if (stat.isDirectory()) {
      // List directory contents
      const entries = fs.readdirSync(resolved, { withFileTypes: true })
      const listing = entries.map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`).join('\n')
      return {
        content: [{ type: 'text' as const, text: `=== ${filePath} ===\n${listing}` }]
      }
    }

    // Limit file size to prevent token explosion (max 200KB)
    if (stat.size > 200 * 1024) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `File too large (${Math.round(stat.size / 1024)}KB). Use lines parameter to read a portion.`
          }
        ],
        isError: true
      }
    }

    try {
      const content = fs.readFileSync(resolved, 'utf-8')
      if (requestedLines && requestedLines > 0) {
        const allLines = content.split('\n')
        const limited = allLines.slice(0, Math.min(requestedLines, 1000)).join('\n')
        return {
          content: [
            {
              type: 'text' as const,
              text: `=== ${filePath} (first ${Math.min(requestedLines, allLines.length)} of ${allLines.length} lines) ===\n${limited}`
            }
          ]
        }
      }
      return {
        content: [{ type: 'text' as const, text: `=== ${filePath} ===\n${content}` }]
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`
          }
        ],
        isError: true
      }
    }
  }
}

function normalizeAllowedRoots(roots: string[]) {
  const defaultRoots = [app.getPath('desktop'), app.getPath('documents'), app.getPath('downloads'), app.getPath('temp')]
  const allRoots = [...roots, ...defaultRoots]
  return [...new Set(allRoots.filter(Boolean).map((root) => path.resolve(root)))]
}

function isPathInside(target: string, root: string) {
  const relative = path.relative(root, target)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function validateReferenceImageDiversity(
  reference: PptxStyleReferenceProfile,
  slides: NormalizedSlide[],
  assets: Map<string, LoadedImageAsset>
) {
  const assignedIds = slides.map((slide) => slide.imageAssetId).filter((id): id is string => Boolean(id))
  const hashCounts = new Map<string, number>()
  for (const id of assignedIds) {
    const asset = assets.get(id)
    if (!asset) continue
    const hash = createHash('sha256').update(asset.data).digest('hex')
    hashCounts.set(hash, (hashCounts.get(hash) || 0) + 1)
  }
  const uniqueMedia = hashCounts.size
  const dominantReuseRatio = assignedIds.length ? Math.max(0, ...hashCounts.values()) / assignedIds.length : 0

  if (isImageHeavyPptxReference(reference)) {
    const minimumAssignments = Math.max(1, Math.ceil(slides.length * reference.metrics.pictureSlideRatio * 0.7))
    if (assignedIds.length < minimumAssignments) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `The reference deck is image-heavy and requires at least ${minimumAssignments} image-led output slides for this ${slides.length}-slide deck; only ${assignedIds.length} were assigned. Preserve the source's photo cadence with topic-relevant assets.`
      )
    }

    const minimumUniqueMedia = Math.min(assignedIds.length, Math.max(2, Math.ceil(minimumAssignments * 0.55)))
    if (assignedIds.length >= 4 && uniqueMedia < minimumUniqueMedia) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `The reference deck is image-heavy, but ${assignedIds.length} image placements use only ${uniqueMedia} distinct image file(s). Provide at least ${minimumUniqueMedia} genuinely different, topic-relevant visuals instead of repeatedly reusing one or two illustrations.`
      )
    }
    if (assignedIds.length >= 4 && dominantReuseRatio > 0.5) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `One image is reused on ${Math.round(dominantReuseRatio * 100)}% of image-led slides. Keep any single visual at or below 50% reuse so the output preserves the reference deck's media variety.`
      )
    }
  }

  return {
    assignments: assignedIds.length,
    uniqueMedia,
    dominantReuseRatio: Math.round(dominantReuseRatio * 100) / 100
  }
}

function validateNativeTemplateImageReplacements(
  input: PptxTemplateInput,
  template: PptxStyleReferenceProfile,
  slides: NormalizedSlide[]
) {
  const missing = slides.flatMap((slide, index) => {
    if (slide.preserveContent || slide.imageAssetId) return []
    const sourceSlideNumber =
      slide.templateSlideNumber || input.source_slide_number || Math.min(index + 1, template.slideCount)
    const sourcePattern = template.composition.slides[sourceSlideNumber - 1]
    if (!sourcePattern || sourcePattern.pictureCoverage < 0.12) return []
    return [{ outputSlideNumber: index + 1, sourceSlideNumber }]
  })
  if (!missing.length) return

  const mapping = missing
    .map((item) => `output ${item.outputSlideNumber} <- template ${item.sourceSlideNumber}`)
    .join(', ')
  throw new McpError(
    ErrorCode.InvalidParams,
    `Native template generation is changing content on photo-led source pages without replacing their off-topic main pictures (${mapping}). Create distinct topic-relevant local image assets, assign image_asset_id on these output slides, and retry automatically. Do not ask the user to restate this requirement. Use preserve_content only when the original page content and photo are intentionally kept.`
  )
}

function normalizeFormat(format: string | undefined, filePath: string): SupportedFileFormat {
  const rawFormat = (format || path.extname(filePath).slice(1)).toLowerCase()
  if (SUPPORTED_FILE_FORMATS.includes(rawFormat as SupportedFileFormat)) {
    return rawFormat as SupportedFileFormat
  }
  throw new McpError(
    ErrorCode.InvalidParams,
    `Unsupported file format: ${rawFormat || '(empty)'}. Supported formats: ${SUPPORTED_FILE_FORMATS.join(', ')}`
  )
}

function normalizeRows(rows: CellValue[][] | undefined, content: string): string[][] {
  if (Array.isArray(rows) && rows.length > 0) {
    return rows.map((row) =>
      Array.isArray(row) ? row.map((cell) => stringifyCell(cell)) : [stringifyCell(row as any)]
    )
  }

  const trimmed = content.trim()
  if (!trimmed) return [['Content'], ['']]

  return trimmed.split(/\r?\n/).map((line) => {
    if (line.includes('\t')) return line.split('\t').map((cell) => cell.trim())
    if (line.includes(',')) return splitCsvLine(line)
    return [line.trim()]
  })
}

function normalizeSlides(slides: SlideInput[] | undefined, title: string, content: string): NormalizedSlide[] {
  if (Array.isArray(slides) && slides.length > 0) {
    return slides.map((slide, index) => {
      const normalizedTitle = slide.title?.trim() || `${title} ${index + 1}`
      const bullets = Array.isArray(slide.bullets)
        ? slide.bullets.map((item) => String(item).trim()).filter(Boolean)
        : []
      const requestedLayout = normalizeSlideLayout(slide.layout, index, slides.length, normalizedTitle, bullets)
      const imageAssetId = slide.image_asset_id?.trim() || undefined
      return {
        title: normalizedTitle,
        subtitle: slide.subtitle?.trim() || undefined,
        layout: imageAssetId ? 'image' : resolvePptxLayoutForContent(requestedLayout, bullets),
        takeaway: slide.takeaway?.trim() || undefined,
        visual: slide.visual?.trim() || undefined,
        accent: normalizePptxAccent(slide.accent, index),
        accentExplicit: typeof slide.accent === 'string' && slide.accent.trim().length > 0,
        bullets,
        notes: slide.notes ? String(slide.notes) : undefined,
        imageAssetId,
        preserveContent: slide.preserve_content === true,
        templateSlideNumber: slide.template_slide_number,
        targetSlideNumber: slide.target_slide_number
      }
    })
  }

  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length === 0) {
    return [{ title, layout: 'cover', accent: 'blue', accentExplicit: false, bullets: [''] }]
  }

  const slidesFromHeadings: NormalizedSlide[] = []
  let current: NormalizedSlide = { title, layout: 'cover', accent: 'blue', accentExplicit: false, bullets: [] }

  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.+)$/)
    if (heading) {
      if (current.bullets.length > 0 || slidesFromHeadings.length === 0) {
        slidesFromHeadings.push(current)
      }
      current = {
        title: heading[1].trim(),
        layout: 'insight',
        accent: normalizePptxAccent(undefined, slidesFromHeadings.length),
        accentExplicit: false,
        bullets: []
      }
      continue
    }
    current.bullets.push(line.replace(/^[-*]\s+/, ''))
  }

  if (current.bullets.length > 0 || slidesFromHeadings.length === 0) {
    slidesFromHeadings.push(current)
  }

  const cappedSlides = slidesFromHeadings.slice(0, 30)
  return cappedSlides.map((slide, index) => ({
    ...slide,
    layout: resolvePptxLayoutForContent(
      normalizeSlideLayout(slide.layout, index, cappedSlides.length, slide.title, slide.bullets),
      slide.bullets
    ),
    accent: normalizePptxAccent(slide.accent, index)
  }))
}

function normalizeSlideLayout(
  layout: string | undefined,
  index: number,
  total: number,
  title: string,
  bullets: string[]
): PptxSlideLayout {
  const allowed = new Set<PptxSlideLayout>([
    'cover',
    'agenda',
    'section',
    'insight',
    'cards',
    'process',
    'timeline',
    'network',
    'matrix',
    'schedule',
    'route',
    'comparison',
    'metric',
    'chart',
    'image',
    'quote',
    'summary'
  ])
  if (layout && allowed.has(layout as PptxSlideLayout)) return layout as PptxSlideLayout

  const normalizedTitle = title.toLowerCase()
  if (index === 0) return 'cover'
  if (/(agenda|目录|大纲|roadmap)/i.test(title)) return 'agenda'
  if (/(section|章节|篇章|part\s+\d+)/i.test(title)) return 'section'
  if (/(summary|总结|结论|next|下一步|行动)/i.test(title) || index === total - 1) return 'summary'
  if (/(quote|引言|金句|观点|testimonial|客户评价)/i.test(title)) return 'quote'
  if (/(network|ecosystem map|关系网络|协作网络|生态网络|利益相关者|关系图谱)/i.test(title)) return 'network'
  if (/(matrix|quadrant|矩阵|象限|二维分析)/i.test(title)) return 'matrix'
  if (/(schedule|agenda by time|run of show|日程|议程安排|会期|排期|时段安排)/i.test(title)) return 'schedule'
  if (/(route|journey map|路径图|路线|旅程|动线|站点地图)/i.test(title)) return 'route'
  if (/(compare|comparison|对比|竞品|before|after|vs\.?)/i.test(title)) return 'comparison'
  if (/(chart|柱状图|条形图|趋势|占比|分布|数据图)/i.test(title)) return 'chart'
  if (/(metric|kpi|数据|指标|增长|收入|成本|转化)/i.test(normalizedTitle)) return 'metric'
  if (/(timeline|时间线|里程碑|roadmap)/i.test(title)) return 'timeline'
  if (/(process|流程|步骤|路径)/i.test(title)) return 'process'
  if (bullets.length >= 3 && bullets.length <= 5) return 'cards'
  return 'insight'
}

function normalizePptxAccent(accent: string | undefined, index: number): PptxAccent {
  const accents: PptxAccent[] = ['blue', 'green', 'amber', 'purple', 'cyan', 'coral', 'red', 'slate']
  if (accent && accents.includes(accent as PptxAccent)) return accent as PptxAccent
  return accents[index % accents.length]
}

function resolvePptxLayoutForContent(layout: PptxSlideLayout, bullets: string[]): PptxSlideLayout {
  if (layout === 'metric' && (!bullets.length || !bullets.every((bullet) => parseMetricBullet(bullet).valid))) {
    return bullets.length >= 2 && bullets.length <= 4 ? 'cards' : 'insight'
  }
  return layout
}

async function createOutputBuffer(options: OutputBufferOptions): Promise<Buffer> {
  switch (options.format) {
    case 'md':
    case 'txt':
      return Buffer.from(options.content || options.title, 'utf-8')
    case 'csv':
      return Buffer.from('\uFEFF' + toCsv(options.rows), 'utf-8')
    case 'docx':
      return await createDocxBuffer(options.title, options.content, options.rows, options.assets, options.style)
    case 'xlsx':
      return createXlsxBuffer(options.workbook, options.rows, options.title)
    case 'pptx':
      return await createPptxBuffer(options.slides, options.assets, options.style, options.referenceProfile)
    case 'pdf':
      return await createPdfBuffer(options.title, options.content, options.assets, options.style)
  }
}

function applyPptxReferenceRhythm(slides: NormalizedSlide[], reference: PptxStyleReferenceProfile): NormalizedSlide[] {
  const patterns = reference.composition.slides
  if (!patterns.length) return slides
  return slides.map((slide, index) => {
    const sourceIndex =
      slides.length <= 1 || patterns.length <= 1 ? 0 : Math.round((index * (patterns.length - 1)) / (slides.length - 1))
    const referencePattern = patterns[Math.min(sourceIndex, patterns.length - 1)]
    let layout = slide.layout
    if (slide.imageAssetId) {
      if (referencePattern.archetype === 'full-bleed-image') layout = index === 0 ? 'cover' : 'section'
      else if (referencePattern.archetype === 'photo-chapter') layout = 'section'
      else if (referencePattern.archetype === 'image-text') layout = 'image'
    } else if (referencePattern.archetype === 'chart-report' && slide.bullets.some((bullet) => /\d/.test(bullet))) {
      layout = 'chart'
    }
    return { ...slide, layout, referencePattern }
  })
}

function isReferencePhotoPage(slide: NormalizedSlide) {
  return Boolean(
    slide.imageAssetId &&
      (slide.referencePattern?.archetype === 'full-bleed-image' ||
        slide.referencePattern?.archetype === 'photo-chapter')
  )
}

export async function createPptxBuffer(
  slides: NormalizedSlide[],
  assets: Map<string, LoadedImageAsset> = new Map(),
  style?: ResolvedDocumentStyle,
  referenceProfile?: PptxStyleReferenceProfile
) {
  const baseSlides = slides.length
    ? slides.map((slide) => ({
        ...slide,
        bullets: slide.bullets || [],
        layout: resolvePptxLayoutForContent(slide.layout, slide.bullets || [])
      }))
    : [{ title: 'Slide 1', layout: 'cover' as const, accent: 'blue' as const, accentExplicit: false, bullets: [''] }]
  const normalizedSlides = referenceProfile ? applyPptxReferenceRhythm(baseSlides, referenceProfile) : baseSlides
  const documentStyle =
    style ??
    resolveDocumentStyle({
      title: normalizedSlides[0]?.title || '',
      content: normalizedSlides.flatMap((slide) => [slide.title, ...(slide.bullets || [])]).join('\n'),
      format: 'pptx'
    })

  const presentation = new PptxGenJS()
  presentation.defineLayout({ name: 'ZEN_AI_WIDE', width: 10, height: 5.625 })
  presentation.layout = 'ZEN_AI_WIDE'
  presentation.author = 'Zen AI'
  presentation.company = 'Zen AI'
  presentation.subject = 'Generated presentation'
  presentation.title = normalizedSlides[0]?.title || 'Zen AI Presentation'
  presentation.theme = { headFontFace: documentStyle.headingFont, bodyFontFace: documentStyle.bodyFont }
  normalizedSlides.forEach((slide, index) => {
    const presentationSlide = presentation.addSlide()
    if (!slide.imageAssetId) return
    const asset = assets.get(slide.imageAssetId)
    if (!asset) throw new Error(`PPTX slide references missing image asset: ${slide.imageAssetId}`)
    const theme = resolvePptxSlideTheme(documentStyle, slide, index, referenceProfile?.designLanguage)
    const placement =
      slide.layout === 'image' || isReferencePhotoPage(slide)
        ? resolvePptxImagePlacement(theme, slide.referencePattern)
        : { x: 5.55, y: 1.2, width: 3.9, height: 3.55, fit: 'contain' as const, rounding: false }
    const bounds =
      placement.fit === 'contain'
        ? fitPptxImage(asset, placement)
        : { x: placement.x, y: placement.y, width: placement.width, height: placement.height }
    presentationSlide.addImage({
      data: `data:image/png;base64,${asset.data.toString('base64')}`,
      x: bounds.x,
      y: bounds.y,
      w: bounds.width,
      h: bounds.height,
      altText: asset.altText,
      objectName: `${theme.language} image asset`,
      rounding: placement.rounding,
      ...(placement.fit === 'cover'
        ? { sizing: { type: 'cover' as const, w: placement.width, h: placement.height } }
        : {})
    })
  })

  const skeleton = await presentation.write({ outputType: 'nodebuffer', compression: true })
  if (!(skeleton instanceof Uint8Array)) {
    throw new Error('PPTX generator returned an unsupported output type')
  }

  const zip = new AdmZip(Buffer.from(skeleton))
  sanitizePptxSkeleton(zip, documentStyle.eastAsiaFont)

  const embeddedPictures = normalizedSlides.map((_, index) =>
    extractPptxPictureXml(zip, `ppt/slides/slide${index + 1}.xml`, 10_000 + index * 10)
  )

  normalizedSlides.forEach((slide, index) => {
    zip.updateFile(
      `ppt/slides/slide${index + 1}.xml`,
      Buffer.from(
        createSlideXml(
          slide,
          index,
          normalizedSlides.length,
          documentStyle,
          embeddedPictures[index],
          referenceProfile?.designLanguage
        ),
        'utf-8'
      )
    )
  })

  return zip.toBuffer()
}

function fitPptxImage(
  asset: Pick<LoadedImageAsset, 'width' | 'height'>,
  box: { x: number; y: number; width: number; height: number }
) {
  const scale = Math.min(box.width / asset.width, box.height / asset.height)
  const width = asset.width * scale
  const height = asset.height * scale
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height
  }
}

interface PptxImagePlacement {
  x: number
  y: number
  width: number
  height: number
  fit: 'contain' | 'cover'
  rounding: boolean
}

function resolvePptxImagePlacement(theme: PptxTheme, referencePattern?: PptxReferenceSlidePattern): PptxImagePlacement {
  if (
    referencePattern?.archetype === 'full-bleed-image' ||
    referencePattern?.archetype === 'photo-chapter' ||
    referencePattern?.picturePlacement === 'full'
  ) {
    return { x: 0, y: 0, width: 10, height: 5.625, fit: 'cover', rounding: false }
  }
  if (referencePattern?.archetype === 'image-text') {
    const referencePlacements: Partial<Record<PptxReferenceSlidePattern['picturePlacement'], PptxImagePlacement>> = {
      left: { x: 0.62, y: 1.35, width: 4.25, height: 3.72, fit: 'cover', rounding: false },
      right: { x: 5.12, y: 1.35, width: 4.25, height: 3.72, fit: 'cover', rounding: false },
      top: { x: 0.72, y: 1.36, width: 8.56, height: 2.35, fit: 'cover', rounding: false },
      bottom: { x: 0.72, y: 2.48, width: 8.56, height: 2.46, fit: 'cover', rounding: false },
      center: { x: 2.1, y: 1.38, width: 5.8, height: 3.55, fit: 'cover', rounding: false }
    }
    const placement = referencePlacements[referencePattern.picturePlacement]
    if (placement) return placement
  }
  if (theme.composition === 'kinetic' && usesExpressiveComposition(theme)) {
    return { x: 4.4, y: 1.18, width: 5.3, height: 3.92, fit: 'cover', rounding: false }
  }
  if (theme.composition === 'spatial' && usesExpressiveComposition(theme)) {
    return { x: 0.75, y: 1.42, width: 5.75, height: 3.6, fit: 'cover', rounding: theme.shape === 'roundRect' }
  }
  const placements: Record<PptxLayoutLanguage, PptxImagePlacement> = {
    classic: { x: 5.4, y: 1.35, width: 3.85, height: 3.35, fit: 'contain', rounding: false },
    executive: { x: 3.7, y: 1.42, width: 5.65, height: 3.45, fit: 'cover', rounding: false },
    consulting: { x: 0.84, y: 2.38, width: 8.34, height: 2.42, fit: 'cover', rounding: false },
    formal: { x: 0.86, y: 1.66, width: 5.1, height: 3.08, fit: 'contain', rounding: false },
    technical: { x: 4.66, y: 1.72, width: 4.44, height: 2.82, fit: 'contain', rounding: false },
    product: { x: 3.45, y: 1.48, width: 5.55, height: 3.44, fit: 'contain', rounding: false },
    data: { x: 0.84, y: 1.72, width: 3.72, height: 2.86, fit: 'contain', rounding: false },
    bold: { x: 4.72, y: 1.04, width: 5.28, height: 3.9, fit: 'cover', rounding: false },
    brand: { x: 2.96, y: 1.25, width: 6.54, height: 3.82, fit: 'cover', rounding: false },
    editorial: { x: 0.86, y: 2.24, width: 8.3, height: 2.58, fit: 'cover', rounding: false },
    playful: { x: 4.92, y: 1.55, width: 3.75, height: 3.42, fit: 'cover', rounding: true },
    organic: { x: 4.02, y: 1.4, width: 4.65, height: 3.46, fit: 'cover', rounding: true },
    premium: { x: 1.2, y: 1.78, width: 6.92, height: 2.58, fit: 'cover', rounding: false },
    minimal: { x: 4.68, y: 1.42, width: 3.64, height: 3.32, fit: 'contain', rounding: false }
  }
  return placements[theme.language]
}

type OrderedXmlNode = Record<string, unknown>

const PPTX_XML_OPTIONS = {
  ignoreAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  preserveOrder: true,
  processEntities: false,
  trimValues: false
} as const

const pptxXmlParser = new XMLParser(PPTX_XML_OPTIONS)
const pptxXmlBuilder = new XMLBuilder(PPTX_XML_OPTIONS)
const NOTES_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide'
])

function sanitizePptxSkeleton(zip: AdmZip, eastAsiaFont: string): void {
  const notesEntries = zip
    .getEntries()
    .filter(
      (entry) => entry.entryName.startsWith('ppt/notesMasters/') || entry.entryName.startsWith('ppt/notesSlides/')
    )
    .sort((left, right) => Number(left.isDirectory) - Number(right.isDirectory))
  for (const entry of notesEntries) {
    zip.deleteFile(entry.entryName)
  }

  updateOrderedXml(zip, 'ppt/presentation.xml', (document) => {
    const children = orderedElementChildren(document, 'p:presentation')
    removeOrderedElements(children, 'p:notesMasterIdLst')
  })

  const relationshipParts = [
    'ppt/_rels/presentation.xml.rels',
    ...zip
      .getEntries()
      .map((entry) => entry.entryName)
      .filter((entryName) => /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(entryName))
  ]
  for (const relationshipPart of relationshipParts) {
    updateOrderedXml(zip, relationshipPart, (document) => {
      const children = orderedElementChildren(document, 'Relationships')
      removeOrderedElements(children, 'Relationship', (node) =>
        NOTES_RELATIONSHIP_TYPES.has(orderedAttribute(node, 'Type') || '')
      )
    })
  }

  const packageParts = new Set(zip.getEntries().map((entry) => entry.entryName))
  updateOrderedXml(zip, '[Content_Types].xml', (document) => {
    const children = orderedElementChildren(document, 'Types')
    removeOrderedElements(children, 'Override', (node) => {
      const partName = orderedAttribute(node, 'PartName')?.replace(/^\//, '')
      return Boolean(partName && !packageParts.has(partName))
    })
  })

  updateOrderedXml(zip, 'docProps/app.xml', (document) => {
    const children = orderedElementChildren(document, 'Properties')
    const notes = children.find((node) => Object.hasOwn(node, 'Notes'))
    if (notes) notes.Notes = [{ '#text': '0' }]
  })

  updateOrderedXml(zip, 'ppt/theme/theme1.xml', (document) => {
    walkOrderedXml(document, (node) => {
      if (!Object.hasOwn(node, 'a:majorFont') && !Object.hasOwn(node, 'a:minorFont')) return
      const tagName = Object.hasOwn(node, 'a:majorFont') ? 'a:majorFont' : 'a:minorFont'
      const children = node[tagName]
      if (!Array.isArray(children)) return
      for (const child of children as OrderedXmlNode[]) {
        if (Object.hasOwn(child, 'a:ea')) setOrderedAttribute(child, 'typeface', eastAsiaFont)
        if (Object.hasOwn(child, 'a:font') && orderedAttribute(child, 'script') === 'Hans') {
          setOrderedAttribute(child, 'typeface', eastAsiaFont)
        }
      }
    })
  })
}

function updateOrderedXml(zip: AdmZip, partName: string, update: (document: OrderedXmlNode[]) => void): void {
  const source = zip.readAsText(partName)
  if (!source) throw new Error(`PPTX skeleton is missing ${partName}`)
  const document = pptxXmlParser.parse(source) as OrderedXmlNode[]
  update(document)
  zip.updateFile(partName, Buffer.from(pptxXmlBuilder.build(document), 'utf-8'))
}

function orderedElementChildren(document: OrderedXmlNode[], tagName: string): OrderedXmlNode[] {
  const element = document.find((node) => Object.hasOwn(node, tagName))
  const children = element?.[tagName]
  if (!Array.isArray(children)) throw new Error(`PPTX XML is missing ${tagName}`)
  return children as OrderedXmlNode[]
}

function removeOrderedElements(
  children: OrderedXmlNode[],
  tagName: string,
  shouldRemove: (node: OrderedXmlNode) => boolean = () => true
): void {
  for (let index = children.length - 1; index >= 0; index--) {
    const node = children[index]
    if (Object.hasOwn(node, tagName) && shouldRemove(node)) children.splice(index, 1)
  }
}

function orderedAttribute(node: OrderedXmlNode, name: string): string | undefined {
  const attributes = node[':@']
  if (!attributes || typeof attributes !== 'object') return undefined
  const value = (attributes as Record<string, unknown>)[`@_${name}`]
  return typeof value === 'string' ? value : undefined
}

function setOrderedAttribute(node: OrderedXmlNode, name: string, value: string): void {
  const attributes = node[':@']
  const normalized = attributes && typeof attributes === 'object' ? attributes : {}
  ;(normalized as Record<string, unknown>)[`@_${name}`] = value
  node[':@'] = normalized
}

function walkOrderedXml(nodes: OrderedXmlNode[], visit: (node: OrderedXmlNode) => void): void {
  for (const node of nodes) {
    visit(node)
    for (const [key, value] of Object.entries(node)) {
      if (key !== ':@' && Array.isArray(value)) walkOrderedXml(value as OrderedXmlNode[], visit)
    }
  }
}

function extractPptxPictureXml(zip: AdmZip, partName: string, firstShapeId: number): string {
  const source = zip.readAsText(partName)
  if (!source) throw new Error(`PPTX skeleton is missing ${partName}`)
  const document = pptxXmlParser.parse(source) as OrderedXmlNode[]
  const pictures: OrderedXmlNode[] = []
  walkOrderedXml(document, (node) => {
    if (Object.hasOwn(node, 'p:pic')) pictures.push(structuredClone(node))
  })
  pictures.forEach((picture, index) => {
    walkOrderedXml([picture], (node) => {
      if (!Object.hasOwn(node, 'p:cNvPr')) return
      setOrderedAttribute(node, 'id', String(firstShapeId + index))
    })
  })
  return pictures.length > 0 ? pptxXmlBuilder.build(pictures) : ''
}

type PdfContentBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'bullet'; marker: string; text: string }
  | { type: 'quote'; text: string }
  | { type: 'code'; text: string }
  | { type: 'table'; rows: string[][] }
  | { type: 'image'; assetId: string; altText: string }

function pdfColor(value: string): ReturnType<typeof rgb> {
  return rgb(
    Number.parseInt(value.slice(0, 2), 16) / 255,
    Number.parseInt(value.slice(2, 4), 16) / 255,
    Number.parseInt(value.slice(4, 6), 16) / 255
  )
}

export async function createPdfBuffer(
  title: string,
  content: string,
  assets: Map<string, LoadedImageAsset> = new Map(),
  style?: ResolvedDocumentStyle
) {
  const documentStyle =
    style ??
    resolveDocumentStyle({
      title,
      content,
      format: 'pdf'
    })
  const colors = {
    primary: pdfColor(documentStyle.primary),
    secondary: pdfColor(documentStyle.secondary),
    accent: pdfColor(documentStyle.accent),
    background: pdfColor(documentStyle.background),
    surface: pdfColor(documentStyle.surface),
    ink: pdfColor(documentStyle.ink),
    muted: pdfColor(documentStyle.muted),
    line: pdfColor(documentStyle.line),
    soft: pdfColor(documentStyle.soft),
    onPrimary: pdfColor(documentStyle.onPrimary)
  }
  const pdfDoc = await PDFDocument.create()
  pdfDoc.registerFontkit(fontkit)
  const font = await loadPdfFont(pdfDoc)
  assertPdfFontCoverage(font, `${title}\n${content}`)
  pdfDoc.setTitle(title)
  pdfDoc.setCreator('Zen AI')
  pdfDoc.setProducer('Zen AI PDF Generator')
  pdfDoc.setSubject('Generated document')

  const pageWidth = 595.28
  const pageHeight = 841.89
  const margin = 48
  const footerHeight = 22
  const contentWidth = pageWidth - margin * 2
  const embeddedImages = new Map<string, Awaited<ReturnType<PDFDocument['embedPng']>>>()
  for (const reference of findImageAssetReferences(content)) {
    if (embeddedImages.has(reference.id)) continue
    const asset = assets.get(reference.id)
    if (!asset) throw new Error(`PDF content references missing image asset: ${reference.id}`)
    embeddedImages.set(reference.id, await pdfDoc.embedPng(asset.data))
  }
  let page: PDFPage = pdfDoc.addPage([pageWidth, pageHeight])
  const pages: PDFPage[] = [page]
  let y = pageHeight - margin

  const drawPageChrome = (target: PDFPage) => {
    target.drawRectangle({ x: 0, y: 0, width: pageWidth, height: pageHeight, color: colors.background })
    if (['editorial', 'formal', 'minimal'].includes(documentStyle.variant)) {
      target.drawRectangle({ x: 0, y: 0, width: 5, height: pageHeight, color: colors.primary })
    } else {
      target.drawRectangle({ x: 0, y: pageHeight - 6, width: pageWidth, height: 6, color: colors.primary })
    }
  }
  drawPageChrome(page)

  const addPage = () => {
    page = pdfDoc.addPage([pageWidth, pageHeight])
    pages.push(page)
    drawPageChrome(page)
    y = pageHeight - margin
  }

  const ensureSpace = (height: number) => {
    if (y - height < margin + footerHeight) addPage()
  }

  const drawWrappedText = (
    text: string,
    options: { size: number; lineHeight: number; color: ReturnType<typeof rgb>; x?: number; width?: number }
  ) => {
    const x = options.x ?? margin
    const width = options.width ?? contentWidth
    const lines = wrapPdfText(cleanPdfText(text), font, options.size, width)
    for (const line of lines.length ? lines : ['']) {
      ensureSpace(options.lineHeight)
      if (line) page.drawText(line, { x, y, size: options.size, font, color: options.color })
      y -= options.lineHeight
    }
  }

  const drawTable = (rows: string[][]) => {
    if (!rows.length) return
    const columnCount = Math.max(1, ...rows.map((row) => row.length))
    const normalizedRows = rows.map((row) => Array.from({ length: columnCount }, (_, index) => row[index] || ''))
    const columnWidth = contentWidth / columnCount
    const fontSize = columnCount >= 6 ? 7.5 : columnCount >= 4 ? 8.5 : 9
    const lineHeight = fontSize + 3
    const padding = 5
    const headerLines = normalizedRows[0].map((cell) =>
      wrapPdfText(cleanPdfText(cell), font, fontSize, columnWidth - padding * 2)
    )

    const drawChunk = (lineSets: string[][], offset: number, lineCount: number, header: boolean) => {
      const rowHeight = Math.max(1, lineCount) * lineHeight + padding * 2
      const top = y
      lineSets.forEach((lines, columnIndex) => {
        const x = margin + columnIndex * columnWidth
        page.drawRectangle({
          x,
          y: top - rowHeight,
          width: columnWidth,
          height: rowHeight,
          color: header ? colors.primary : colors.surface,
          borderColor: colors.line,
          borderWidth: 0.6
        })
        lines.slice(offset, offset + lineCount).forEach((line, lineIndex) => {
          if (!line) return
          page.drawText(line, {
            x: x + padding,
            y: top - padding - fontSize - lineIndex * lineHeight,
            size: fontSize,
            font,
            color: header ? colors.onPrimary : colors.ink
          })
        })
      })
      y -= rowHeight
    }

    const drawHeader = () => {
      const lineCount = Math.max(1, ...headerLines.map((lines) => lines.length))
      ensureSpace(lineCount * lineHeight + padding * 2)
      drawChunk(headerLines, 0, lineCount, true)
    }

    drawHeader()
    for (let rowIndex = 1; rowIndex < normalizedRows.length; rowIndex++) {
      const lineSets = normalizedRows[rowIndex].map((cell) =>
        wrapPdfText(cleanPdfText(cell), font, fontSize, columnWidth - padding * 2)
      )
      const totalLines = Math.max(1, ...lineSets.map((lines) => lines.length))
      let offset = 0
      while (offset < totalLines) {
        const availableLines = Math.floor((y - margin - footerHeight - padding * 2) / lineHeight)
        if (availableLines < 1) {
          addPage()
          drawHeader()
          continue
        }
        const lineCount = Math.min(totalLines - offset, availableLines)
        drawChunk(lineSets, offset, lineCount, false)
        offset += lineCount
        if (offset < totalLines) {
          addPage()
          drawHeader()
        }
      }
    }
    y -= 12
  }

  const titleSize = ['editorial', 'bold'].includes(documentStyle.variant) ? 22 : 20
  drawWrappedText(title, { size: titleSize, lineHeight: titleSize + 7, color: colors.ink })
  page.drawRectangle({
    x: margin,
    y: y - 1,
    width: documentStyle.variant === 'minimal' ? 48 : 86,
    height: documentStyle.variant === 'bold' ? 6 : 3,
    color: colors.accent
  })
  y -= 12

  const blocks = parsePdfBlocks(content || title)
  const firstBlock = blocks[0]
  if (
    firstBlock?.type === 'heading' &&
    firstBlock.level === 1 &&
    normalizeDocumentTitle(firstBlock.text) === normalizeDocumentTitle(title)
  ) {
    blocks.shift()
  }

  for (const block of blocks) {
    if (block.type === 'heading') {
      const size = block.level === 1 ? 16 : block.level === 2 ? 13 : 11.5
      const lineHeight = size + 7
      ensureSpace(lineHeight + 8)
      y -= block.level === 1 ? 8 : 4
      drawWrappedText(block.text, { size, lineHeight, color: block.level === 1 ? colors.primary : colors.secondary })
      y -= 3
      continue
    }
    if (block.type === 'bullet') {
      ensureSpace(17)
      page.drawText(block.marker, { x: margin + 4, y, size: 10.5, font, color: colors.accent })
      drawWrappedText(block.text, {
        size: 10.5,
        lineHeight: 16,
        color: colors.ink,
        x: margin + 28,
        width: contentWidth - 28
      })
      y -= 2
      continue
    }
    if (block.type === 'quote') {
      const lines = wrapPdfText(cleanPdfText(block.text), font, 10.5, contentWidth - 34)
      const boxHeight = Math.max(1, lines.length) * 16 + 16
      ensureSpace(boxHeight)
      const top = y + 4
      page.drawRectangle({
        x: margin,
        y: top - boxHeight,
        width: contentWidth,
        height: boxHeight,
        color: colors.soft,
        borderColor: colors.line,
        borderWidth: 0.5
      })
      page.drawRectangle({ x: margin, y: top - boxHeight, width: 4, height: boxHeight, color: colors.accent })
      lines.forEach((line, lineIndex) => {
        if (!line) return
        page.drawText(line, {
          x: margin + 16,
          y: top - 14 - lineIndex * 16,
          size: 10.5,
          font,
          color: colors.ink
        })
      })
      y = top - boxHeight - 8
      continue
    }
    if (block.type === 'code') {
      const lines = block.text.split('\n')
      ensureSpace(Math.min(lines.length, 3) * 15 + 12)
      for (const line of lines) {
        const wrapped = wrapPdfText(cleanPdfText(line || ' '), font, 9, contentWidth - 24)
        for (const codeLine of wrapped.length ? wrapped : [' ']) {
          ensureSpace(15)
          page.drawRectangle({ x: margin, y: y - 4, width: contentWidth, height: 15, color: colors.soft })
          if (codeLine.trim()) {
            page.drawText(codeLine, { x: margin + 12, y, size: 9, font, color: colors.ink })
          }
          y -= 15
        }
      }
      y -= 8
      continue
    }
    if (block.type === 'table') {
      ensureSpace(54)
      drawTable(block.rows)
      continue
    }
    if (block.type === 'image') {
      const asset = assets.get(block.assetId)
      const image = embeddedImages.get(block.assetId)
      if (!asset || !image) throw new Error(`PDF content references missing image asset: ${block.assetId}`)
      const dimensions = fitImageWithin(asset, contentWidth, 360)
      const captionHeight = block.altText ? 20 : 0
      ensureSpace(dimensions.height + captionHeight + 12)
      const x = margin + (contentWidth - dimensions.width) / 2
      page.drawImage(image, {
        x,
        y: y - dimensions.height,
        width: dimensions.width,
        height: dimensions.height
      })
      y -= dimensions.height + 6
      if (block.altText) {
        const caption = cleanPdfText(block.altText)
        const captionWidth = font.widthOfTextAtSize(caption, 8.5)
        page.drawText(caption, {
          x: Math.max(margin, (pageWidth - captionWidth) / 2),
          y,
          size: 8.5,
          font,
          color: colors.muted
        })
        y -= 14
      }
      y -= 8
      continue
    }
    drawWrappedText(block.text, { size: 10.5, lineHeight: 16, color: colors.ink })
    y -= 6
  }

  pages.forEach((currentPage, index) => {
    const label = `${index + 1} / ${pages.length}`
    const width = font.widthOfTextAtSize(label, 8.5)
    currentPage.drawText(label, {
      x: (pageWidth - width) / 2,
      y: 24,
      size: 8.5,
      font,
      color: colors.muted
    })
  })

  return Buffer.from(await pdfDoc.save())
}

function parsePdfBlocks(content: string): PdfContentBlock[] {
  const lines = content.split(/\r?\n/)
  const blocks: PdfContentBlock[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index].trim()
    if (!line || /^-{3,}$/.test(line)) {
      index += 1
      continue
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] })
      index += 1
      continue
    }
    const image = line.match(/^!\[([^\]]*)\]\(asset:([A-Za-z0-9][A-Za-z0-9._-]{0,63})\)$/)
    if (image) {
      blocks.push({ type: 'image', altText: image[1].trim(), assetId: image[2] })
      index += 1
      continue
    }
    const bullet = line.match(/^[-*+]\s+(.+)$/)
    if (bullet) {
      blocks.push({ type: 'bullet', marker: '-', text: bullet[1] })
      index += 1
      continue
    }
    const orderedBullet = line.match(/^(\d+)[.)]\s+(.+)$/)
    if (orderedBullet) {
      blocks.push({ type: 'bullet', marker: `${orderedBullet[1]}.`, text: orderedBullet[2] })
      index += 1
      continue
    }
    const quote = line.match(/^>\s?(.*)$/)
    if (quote) {
      const quoteLines = [quote[1]]
      index += 1
      while (index < lines.length) {
        const nextQuote = lines[index].trim().match(/^>\s?(.*)$/)
        if (!nextQuote) break
        quoteLines.push(nextQuote[1])
        index += 1
      }
      blocks.push({ type: 'quote', text: quoteLines.join(' ') })
      continue
    }
    const codeFence = line.match(/^(`{3,}|~{3,})/)
    if (codeFence) {
      const marker = codeFence[1]
      const codeLines: string[] = []
      index += 1
      while (index < lines.length && !new RegExp(`^${marker[0]}{${marker.length},}\\s*$`).test(lines[index].trim())) {
        codeLines.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push({ type: 'code', text: codeLines.join('\n') })
      continue
    }
    if (isMarkdownTableLine(line)) {
      const tableLines: string[] = []
      while (index < lines.length && isMarkdownTableLine(lines[index].trim())) {
        tableLines.push(lines[index].trim())
        index += 1
      }
      const rows = tableLines
        .map(parseMarkdownTableRow)
        .filter((row) => !row.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, ''))))
      if (rows.length) blocks.push({ type: 'table', rows })
      continue
    }

    const paragraph = [line]
    index += 1
    while (index < lines.length) {
      const next = lines[index].trim()
      if (
        !next ||
        /^(#{1,3})\s+/.test(next) ||
        /^[-*+]\s+/.test(next) ||
        /^\d+[.)]\s+/.test(next) ||
        /^>\s?/.test(next) ||
        /^(`{3,}|~{3,})/.test(next) ||
        /^!\[[^\]]*\]\(asset:[A-Za-z0-9][A-Za-z0-9._-]{0,63}\)$/.test(next) ||
        isMarkdownTableLine(next)
      ) {
        break
      }
      paragraph.push(next)
      index += 1
    }
    blocks.push({ type: 'paragraph', text: paragraph.join(' ') })
  }
  return blocks
}

function isMarkdownTableLine(value: string) {
  return /^\|.*\|$/.test(value) && value.split('|').length >= 4
}

function parseMarkdownTableRow(value: string) {
  return value
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cleanPdfText(cell.trim()))
}

function cleanPdfText(value: string) {
  return stripUnsupportedControlCharacters(
    value
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
      .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1$2')
      .replace(/`([^`]+)`/g, '$1')
  )
}

function normalizeDocumentTitle(value: string) {
  return cleanPdfText(value)
    .replace(/\.(?:pdf|docx|pptx)$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase()
}

function wrapPdfText(text: string, font: PDFFont, size: number, maxWidth: number) {
  if (!text) return ['']
  const lines: string[] = []
  let current = ''
  let lastBreak = -1
  for (const char of [...text]) {
    const candidate = current + char
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !current) {
      current = candidate
      if (/\s|[，。；、！？：,.!?;:]/.test(char)) lastBreak = current.length
      continue
    }
    if (lastBreak > 0) {
      lines.push(current.slice(0, lastBreak).trimEnd())
      current = current.slice(lastBreak).trimStart() + char
    } else {
      lines.push(current)
      current = char
    }
    lastBreak = -1
  }
  if (current) lines.push(current)
  return lines
}

function assertPdfFontCoverage(font: PDFFont, text: string) {
  const supported = new Set(font.getCharacterSet())
  const missing = [
    ...new Set([...text].map((char) => char.codePointAt(0) || 0).filter((code) => code > 31 && !supported.has(code)))
  ]
  if (!missing.length) return
  const preview = missing
    .slice(0, 12)
    .map((code) => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`)
    .join(', ')
  throw new Error(`PDF font does not cover ${missing.length} required character(s): ${preview}`)
}

async function loadPdfFont(pdfDoc: PDFDocument) {
  try {
    const fontPath = await findBundledPdfFontPath()
    logger.debug('Loading bundled PDF font', { fontPath })
    const fontBytes = await fsp.readFile(fontPath)
    return await pdfDoc.embedFont(fontBytes, { subset: true })
  } catch (error) {
    logger.warn('Failed to load bundled PDF font, falling back to Helvetica', {
      error: error instanceof Error ? error.message : String(error)
    })
    return await pdfDoc.embedFont(StandardFonts.Helvetica)
  }
}

async function findBundledPdfFontPath() {
  const appRoot = typeof app?.getAppPath === 'function' ? app.getAppPath() : process.cwd()
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const directCandidates = [
    path.join(process.cwd(), 'resources', 'fonts', 'NotoSansCJKsc-Regular.otf'),
    ...(resourcesPath ? [path.join(resourcesPath, 'resources', 'fonts', 'NotoSansCJKsc-Regular.otf')] : []),
    path.join(appRoot, 'resources', 'fonts', 'NotoSansCJKsc-Regular.otf'),
    path.join(path.dirname(appRoot), 'resources', 'fonts', 'NotoSansCJKsc-Regular.otf'),
    path.join(appRoot, 'src', 'renderer', 'src', 'assets', 'fonts', 'harmonyos', 'HarmonyOS_Sans_Regular.ttf'),
    path.join(appRoot, 'resources', 'fonts', 'HarmonyOS_Sans_Regular.ttf'),
    path.join(appRoot, 'out', 'renderer', 'assets', 'HarmonyOS_Sans_Regular.ttf')
  ]

  for (const candidate of directCandidates) {
    for (const resolvedCandidate of candidatePathVariants(candidate)) {
      try {
        await fsp.access(resolvedCandidate, fs.constants.R_OK)
        return resolvedCandidate
      } catch {
        // Try the next known location.
      }
    }
  }

  const assetDirs = [
    path.join(appRoot, 'out', 'renderer', 'assets'),
    path.join(path.dirname(appRoot), 'out', 'renderer', 'assets')
  ]

  for (const assetDir of assetDirs) {
    for (const resolvedAssetDir of candidatePathVariants(assetDir)) {
      try {
        const entries = await fsp.readdir(resolvedAssetDir)
        const match =
          entries.find((entry) => /^NotoSansCJKsc-Regular.*\.otf$/i.test(entry)) ??
          entries.find((entry) => /^HarmonyOS_Sans_Regular.*\.ttf$/i.test(entry))
        if (match) return path.join(resolvedAssetDir, match)
      } catch {
        // Asset directory may not exist in dev or in some packaged layouts.
      }
    }
  }

  throw new Error('Bundled PDF font not found')
}

function candidatePathVariants(filePath: string) {
  const unpackedPath = toAsarUnpackedPath(filePath)
  return unpackedPath === filePath ? [filePath] : [filePath, unpackedPath]
}

const PPTX_SLIDE_W = 9144000
const PPTX_SLIDE_H = 5143500
const PPTX_MARGIN_X = 520000
const PPTX_ACCENTS: Record<PptxAccent, { base: string; deep: string; soft: string; text: string }> = {
  blue: { base: '2563EB', deep: '1D4ED8', soft: 'DBEAFE', text: '1E3A8A' },
  green: { base: '059669', deep: '047857', soft: 'D1FAE5', text: '065F46' },
  amber: { base: 'D97706', deep: 'B45309', soft: 'FEF3C7', text: '92400E' },
  purple: { base: '7C3AED', deep: '6D28D9', soft: 'EDE9FE', text: '5B21B6' },
  cyan: { base: '0891B2', deep: '0E7490', soft: 'CFFAFE', text: '155E75' },
  coral: { base: 'EA6655', deep: 'C94C40', soft: 'FDE2DD', text: '9F312B' },
  red: { base: 'DC2626', deep: 'B91C1C', soft: 'FEE2E2', text: '991B1B' },
  slate: { base: '475569', deep: '334155', soft: 'E2E8F0', text: '1E293B' }
}

type PptxTheme = {
  base: string
  onBase: string
  deep: string
  soft: string
  text: string
  ink: string
  muted: string
  bg: string
  card: string
  line: string
  coverBg: string
  coverInk: string
  coverMuted: string
  shape: 'rect' | 'roundRect'
  composition: ResolvedDocumentStyle['composition']
  variant: ResolvedDocumentStyle['variant']
  styleId: ResolvedDocumentStyle['id']
  language: PptxLayoutLanguage
  tones: Array<{ base: string; soft: string; text: string; onBase: string }>
}

type PptxLayoutLanguage =
  | 'classic'
  | 'executive'
  | 'consulting'
  | 'formal'
  | 'technical'
  | 'product'
  | 'data'
  | 'bold'
  | 'brand'
  | 'editorial'
  | 'playful'
  | 'organic'
  | 'premium'
  | 'minimal'

function resolvePptxLayoutLanguage(style: ResolvedDocumentStyle): PptxLayoutLanguage {
  if (style.id === 'executive' || style.id === 'finance') return 'executive'
  if (style.id === 'consulting') return 'consulting'
  if (['government', 'legal', 'academic', 'research', 'monochrome'].includes(style.id)) return 'formal'
  if (style.id === 'technology') return 'technical'
  if (style.id === 'data') return 'data'
  if (style.id === 'product' || style.id === 'sales') return 'product'
  if (style.id === 'startup' || style.id === 'bold') return 'bold'
  if (style.id === 'brand' || style.id === 'creative') return 'brand'
  if (style.id === 'editorial' || style.id === 'culture') return 'editorial'
  if (['education', 'children', 'training'].includes(style.id)) return 'playful'
  if (['healthcare', 'sustainability', 'warm'].includes(style.id)) return 'organic'
  if (style.id === 'premium') return 'premium'
  if (style.id === 'minimal-light' || style.id === 'minimal-dark') return 'minimal'
  return 'classic'
}

function resolveReferencePptxLayoutLanguage(
  baseLanguage: PptxLayoutLanguage,
  designLanguage?: PptxDesignLanguageProfile
): PptxLayoutLanguage {
  if (!designLanguage) return baseLanguage
  if (
    designLanguage.surfaceTreatment === 'photographic' ||
    (designLanguage.pageRhythm === 'editorial' &&
      designLanguage.surfaceTreatment !== 'flat' &&
      ['left-led', 'right-led'].includes(designLanguage.compositionBias))
  ) {
    return 'editorial'
  }
  if (designLanguage.typographyScale === 'display' && designLanguage.contrast === 'high') {
    return designLanguage.paletteStrategy === 'multi-accent' ? 'bold' : 'editorial'
  }
  if (designLanguage.shapeLanguage === 'circular' || designLanguage.shapeLanguage === 'rounded') {
    return ['playful', 'organic'].includes(baseLanguage) ? baseLanguage : 'organic'
  }
  if (designLanguage.pageRhythm === 'evidence-led') {
    return designLanguage.shapeLanguage === 'open' || designLanguage.shapeLanguage === 'linear' ? 'consulting' : 'data'
  }
  if (designLanguage.shapeLanguage === 'open' && designLanguage.spatialRhythm === 'spacious') {
    return ['premium', 'editorial', 'executive'].includes(baseLanguage) ? baseLanguage : 'minimal'
  }
  if (designLanguage.shapeLanguage === 'rectilinear' && designLanguage.decorationDensity === 'rich') {
    return designLanguage.paletteStrategy === 'multi-accent' ? 'brand' : 'product'
  }
  return baseLanguage
}

function pptxContrastText(background: string): string {
  const channels = [0, 2, 4].map((offset) => Number.parseInt(background.slice(offset, offset + 2), 16) / 255)
  const luminance = channels[0] * 0.299 + channels[1] * 0.587 + channels[2] * 0.114
  return luminance > 0.62 ? '172033' : 'FFFFFF'
}

function resolvePptxSlideTheme(
  style: ResolvedDocumentStyle,
  slide: NormalizedSlide,
  index: number,
  referenceDesignLanguage?: PptxDesignLanguageProfile
): PptxTheme {
  const selectedTone = slide.accentExplicit ? PPTX_ACCENTS[slide.accent] : style.tones[index % style.tones.length]
  const lightCover = style.mode !== 'dark' && ['editorial', 'minimal', 'playful', 'organic'].includes(style.variant)
  const coverBg = lightCover ? style.background : style.deep
  const coverInk = pptxContrastText(coverBg)
  const baseLanguage = resolvePptxLayoutLanguage(style)
  const theme: PptxTheme = {
    ...selectedTone,
    onBase: pptxContrastText(selectedTone.base),
    soft: style.mode === 'dark' ? style.soft : selectedTone.soft,
    text: style.mode === 'dark' ? style.ink : selectedTone.text,
    ink: style.ink,
    muted: style.muted,
    bg: style.background,
    card: style.surface,
    line: style.line,
    coverBg,
    coverInk: lightCover ? style.ink : coverInk,
    coverMuted: lightCover ? style.muted : coverInk === 'FFFFFF' ? 'CBD5E1' : style.muted,
    shape:
      referenceDesignLanguage?.shapeLanguage === 'rounded' || referenceDesignLanguage?.shapeLanguage === 'circular'
        ? 'roundRect'
        : referenceDesignLanguage
          ? 'rect'
          : ['classic', 'playful', 'organic'].includes(style.variant)
            ? 'roundRect'
            : 'rect',
    composition: style.composition,
    variant: style.variant,
    styleId: style.id,
    language: resolveReferencePptxLayoutLanguage(baseLanguage, referenceDesignLanguage),
    tones: style.tones.map((tone) => ({
      base: tone.base,
      soft: tone.soft,
      text: style.mode === 'dark' ? style.ink : tone.text,
      onBase: pptxContrastText(tone.base)
    }))
  }
  if (!slide.referencePattern) return theme
  if (slide.referencePattern.dark) {
    return {
      ...theme,
      soft: '243746',
      text: 'E2E8F0',
      ink: 'F8FAFC',
      muted: 'CBD5E1',
      bg: style.deep,
      card: '1E293B',
      line: '475569',
      coverBg: style.deep,
      coverInk: 'FFFFFF',
      coverMuted: 'CBD5E1',
      tones: theme.tones.map((tone) => ({ ...tone, text: 'F8FAFC' }))
    }
  }
  if (style.mode === 'dark') {
    return {
      ...theme,
      soft: selectedTone.soft,
      text: selectedTone.text,
      ink: '172033',
      muted: '64748B',
      bg: 'FFFFFF',
      card: 'F8FAFC',
      line: 'D9E2EC',
      coverBg: 'FFFFFF',
      coverInk: '172033',
      coverMuted: '64748B',
      tones: theme.tones.map((tone, toneIndex) => ({
        ...tone,
        soft: style.tones[toneIndex % style.tones.length].soft,
        text: style.tones[toneIndex % style.tones.length].text
      }))
    }
  }
  return theme
}

function createSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  style: ResolvedDocumentStyle,
  pictureXml = '',
  referenceDesignLanguage?: PptxDesignLanguageProfile
) {
  const theme = resolvePptxSlideTheme(style, slide, index, referenceDesignLanguage)
  const layout = slide.layout
  const referencePhotoPage = isReferencePhotoPage(slide)
  const content =
    referencePhotoPage && layout === 'cover'
      ? createReferencePhotoCoverSlideXml(slide, index, total, theme)
      : referencePhotoPage && layout === 'section'
        ? createReferencePhotoChapterSlideXml(slide, index, total, theme)
        : layout === 'cover'
          ? createCoverSlideXml(slide, index, total, theme)
          : layout === 'section'
            ? createSectionSlideXml(slide, index, total, theme)
            : layout === 'agenda'
              ? createAgendaSlideXml(slide, index, total, theme)
              : layout === 'comparison'
                ? createComparisonSlideXml(slide, index, total, theme)
                : layout === 'process'
                  ? createProcessSlideXml(slide, index, total, theme)
                  : layout === 'timeline'
                    ? createTimelineSlideXml(slide, index, total, theme)
                    : layout === 'network'
                      ? createNetworkSlideXml(slide, index, total, theme)
                      : layout === 'matrix'
                        ? createMatrixSlideXml(slide, index, total, theme)
                        : layout === 'schedule'
                          ? createScheduleSlideXml(slide, index, total, theme)
                          : layout === 'route'
                            ? createRouteSlideXml(slide, index, total, theme)
                            : layout === 'metric'
                              ? createMetricSlideXml(slide, index, total, theme)
                              : layout === 'chart'
                                ? createChartSlideXml(slide, index, total, theme)
                                : layout === 'image'
                                  ? createImageSlideXml(slide, index, total, theme, pictureXml)
                                  : layout === 'quote'
                                    ? createQuoteSlideXml(slide, index, total, theme)
                                    : layout === 'summary'
                                      ? createSummarySlideXml(slide, index, total, theme)
                                      : layout === 'cards'
                                        ? createCardsSlideXml(slide, index, total, theme)
                                        : createInsightSlideXml(slide, index, total, theme)

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      ${referencePhotoPage ? createRect(2, 'Reference photo underlay', 0, 0, PPTX_SLIDE_W, PPTX_SLIDE_H, slide.referencePattern?.dark ? theme.deep : theme.bg) + pictureXml : ''}
      ${content}
      ${layout === 'image' || referencePhotoPage ? '' : pictureXml}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`
}

function createReferencePhotoCoverSlideXml(slide: NormalizedSlide, index: number, total: number, theme: PptxTheme) {
  const panelInk = pptxContrastText(theme.deep)
  return [
    createRect(3, 'Reference cover text field', 0, 0, 4300000, PPTX_SLIDE_H, theme.deep),
    createRect(4, 'Reference cover accent rule', 650000, 720000, 1100000, 42000, theme.base),
    slide.subtitle
      ? createTextBox(5, 'Reference cover kicker', 650000, 880000, 3000000, 320000, [
          { text: slide.subtitle, size: 14, color: theme.base, bold: true }
        ])
      : '',
    createTextBox(6, 'Reference cover title', 650000, 1380000, 3100000, 1500000, [
      { text: slide.title, size: 36, color: panelInk, bold: true }
    ]),
    slide.takeaway
      ? createTextBox(7, 'Reference cover takeaway', 680000, 3260000, 2920000, 620000, [
          { text: slide.takeaway, size: 14, color: 'CBD5E1' }
        ])
      : '',
    createTextBox(8, 'Reference cover folio', 7850000, 3900000, 760000, 620000, [
      { text: String(index + 1).padStart(2, '0'), size: 30, color: 'FFFFFF', bold: true }
    ]),
    createFooter(index, total, 'E2E8F0')
  ].join('')
}

function createReferencePhotoChapterSlideXml(slide: NormalizedSlide, index: number, total: number, theme: PptxTheme) {
  const statement = slide.subtitle || slide.takeaway || slide.bullets[0] || ''
  const panelInk = pptxContrastText(theme.deep)
  return [
    createRect(3, 'Reference chapter title field', 0, 3330000, PPTX_SLIDE_W, 1813500, theme.deep),
    createRect(4, 'Reference chapter accent rule', 680000, 3630000, 900000, 42000, theme.base),
    createTextBox(5, 'Reference chapter title', 680000, 3810000, 5600000, 720000, [
      { text: slide.title, size: 31, color: panelInk, bold: true }
    ]),
    statement
      ? createTextBox(6, 'Reference chapter statement', 6450000, 3800000, 1900000, 600000, [
          { text: statement, size: 13.5, color: 'CBD5E1', bold: true }
        ])
      : '',
    createTextBox(7, 'Reference chapter folio', 8070000, 500000, 620000, 520000, [
      { text: String(index + 1).padStart(2, '0'), size: 27, color: 'FFFFFF', bold: true }
    ]),
    createFooter(index, total, 'E2E8F0')
  ].join('')
}

function createImageSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  theme: PptxTheme,
  pictureXml: string
) {
  const placement = resolvePptxImagePlacement(theme, slide.referencePattern)
  const frame = pptxImagePlacementToEmu(placement)
  const caption = slide.subtitle || slide.takeaway || ''
  const chrome = createBaseSlideChrome(slide, index, total, theme)
  const imageFrame = (name: string, id = 20, padding = 50000) =>
    createRect(
      id,
      name,
      frame.x - padding,
      frame.y - padding,
      frame.width + padding * 2,
      frame.height + padding * 2,
      theme.card,
      theme.line,
      placement.rounding ? 'roundRect' : 'rect'
    )

  if (theme.composition === 'kinetic' && usesExpressiveComposition(theme)) {
    const field = theme.tones[1]
    return [
      chrome,
      createRect(20, 'Kinetic image story field', 520000, 1240000, 3440000, 3660000, field.base),
      imageFrame('Kinetic image stage', 21, 0),
      pictureXml,
      caption
        ? createTextBox(22, 'Kinetic image statement', 880000, 1670000, 2700000, 780000, [
            { text: caption, size: 20, color: field.onBase, bold: true }
          ])
        : '',
      createImagePointRows(slide.bullets, theme, {
        baseId: 40,
        name: 'Kinetic image cue',
        x: 880000,
        y: 2760000,
        width: 2700000,
        rowHeight: 500000,
        max: 4,
        marker: 'bar',
        color: field.onBase
      })
    ].join('')
  }

  if (theme.composition === 'spatial' && usesExpressiveComposition(theme)) {
    return [
      chrome,
      imageFrame('Spatial image plane', 20, 30000),
      pictureXml,
      createRect(21, 'Spatial image axis', 6780000, 1430000, 34000, 3400000, theme.base),
      caption
        ? createTextBox(22, 'Spatial image premise', 7160000, 1550000, 1530000, 920000, [
            { text: caption, size: 17, color: theme.ink, bold: true }
          ])
        : '',
      createImagePointRows(slide.bullets, theme, {
        baseId: 40,
        name: 'Spatial image note',
        x: 7160000,
        y: 2760000,
        width: 1530000,
        rowHeight: 510000,
        max: 4,
        marker: 'rule'
      })
    ].join('')
  }

  if (theme.language === 'executive') {
    const railInk = pptxContrastText(theme.deep)
    return [
      chrome,
      createRect(20, 'Executive image evidence rail', 590000, 1300000, 2500000, 3340000, theme.deep),
      imageFrame('Executive image viewport', 21, 30000),
      pictureXml,
      caption
        ? createTextBox(22, 'Executive image caption', 850000, 1540000, 1960000, 460000, [
            { text: caption, size: 14, color: railInk, bold: true }
          ])
        : '',
      createImagePointRows(slide.bullets, theme, {
        baseId: 40,
        name: 'Executive evidence',
        x: 850000,
        y: 2220000,
        width: 1960000,
        rowHeight: 560000,
        max: 4,
        marker: 'rule',
        color: railInk
      })
    ].join('')
  }

  if (theme.language === 'consulting') {
    return [
      chrome,
      imageFrame('Consulting image panorama', 20, 30000),
      pictureXml,
      caption
        ? createTextBox(21, 'Consulting image thesis', 820000, 1120000, 3600000, 440000, [
            { text: caption, size: 15, color: theme.ink, bold: true }
          ])
        : '',
      createImagePointRows(slide.bullets, theme, {
        baseId: 40,
        name: 'Consulting image finding',
        x: 4560000,
        y: 1120000,
        width: 4250000,
        rowHeight: 350000,
        max: 3,
        marker: 'number'
      })
    ].join('')
  }

  if (theme.language === 'formal') {
    return [
      chrome,
      imageFrame('Formal image plate', 20, 45000),
      pictureXml,
      createRect(21, 'Formal image citation rule', 6260000, 1510000, 2300000, 24000, theme.line),
      caption
        ? createTextBox(22, 'Formal image citation', 6260000, 1700000, 2300000, 620000, [
            { text: caption, size: 13.5, color: theme.ink, bold: true }
          ])
        : '',
      createImagePointRows(slide.bullets, theme, {
        baseId: 40,
        name: 'Formal image note',
        x: 6260000,
        y: 2480000,
        width: 2300000,
        rowHeight: 520000,
        max: 4,
        marker: 'rule'
      })
    ].join('')
  }

  if (theme.language === 'technical') {
    return [
      chrome,
      createRect(20, 'Technical image telemetry', 700000, 1640000, 3320000, 2940000, theme.card, theme.line),
      createRect(21, 'Technical image status rail', 700000, 1640000, 100000, 2940000, theme.base),
      imageFrame('Technical image viewport', 22, 30000),
      pictureXml,
      caption
        ? createTextBox(23, 'Technical image readout', 1050000, 1850000, 2550000, 560000, [
            { text: caption, size: 14, color: theme.ink, bold: true }
          ])
        : '',
      createImagePointRows(slide.bullets, theme, {
        baseId: 40,
        name: 'Technical image signal',
        x: 1050000,
        y: 2580000,
        width: 2550000,
        rowHeight: 480000,
        max: 4,
        marker: 'rule'
      })
    ].join('')
  }

  if (theme.language === 'data') {
    return [
      chrome,
      imageFrame('Data image source panel', 20, 35000),
      pictureXml,
      createRect(21, 'Data image analysis panel', 4860000, 1580000, 3660000, 3070000, theme.card, theme.line),
      caption
        ? createTextBox(22, 'Data image conclusion', 5200000, 1810000, 3000000, 520000, [
            { text: caption, size: 14, color: theme.ink, bold: true }
          ])
        : '',
      createImagePointRows(slide.bullets, theme, {
        baseId: 40,
        name: 'Data image observation',
        x: 5200000,
        y: 2530000,
        width: 3000000,
        rowHeight: 500000,
        max: 4,
        marker: 'bar'
      })
    ].join('')
  }

  if (theme.language === 'product') {
    return [
      chrome,
      createRect(20, 'Product image annotation rail', 650000, 1460000, 2280000, 3460000, theme.soft, theme.line),
      imageFrame('Product image workspace', 21, 40000),
      pictureXml,
      caption
        ? createTextBox(22, 'Product image scenario', 920000, 1710000, 1760000, 540000, [
            { text: caption, size: 14, color: theme.ink, bold: true }
          ])
        : '',
      createImagePointRows(slide.bullets, theme, {
        baseId: 40,
        name: 'Product image annotation',
        x: 920000,
        y: 2460000,
        width: 1760000,
        rowHeight: 510000,
        max: 4,
        marker: 'number'
      })
    ].join('')
  }

  if (theme.language === 'bold') {
    const field = theme.tones[1]
    return [
      chrome,
      createRect(20, 'Bold image manifesto', 0, 1040000, 4720000, 3900000, field.base),
      imageFrame('Bold image field', 21, 0),
      pictureXml,
      caption
        ? createTextBox(22, 'Bold image statement', 650000, 1500000, 3400000, 760000, [
            { text: caption, size: 21, color: field.onBase, bold: true }
          ])
        : '',
      createImagePointRows(slide.bullets, theme, {
        baseId: 40,
        name: 'Bold image proof',
        x: 650000,
        y: 2600000,
        width: 3400000,
        rowHeight: 520000,
        max: 4,
        marker: 'number',
        color: field.onBase
      })
    ].join('')
  }

  if (theme.language === 'brand') {
    const overlay = theme.tones[1]
    return [
      chrome,
      imageFrame('Brand image canvas', 20, 0),
      pictureXml,
      createRect(21, 'Brand image story block', 610000, 1580000, 3060000, 2380000, overlay.base),
      caption
        ? createTextBox(22, 'Brand image story', 920000, 1880000, 2380000, 700000, [
            { text: caption, size: 19, color: overlay.onBase, bold: true }
          ])
        : '',
      createImagePointRows(slide.bullets, theme, {
        baseId: 40,
        name: 'Brand image motif',
        x: 920000,
        y: 2760000,
        width: 2380000,
        rowHeight: 400000,
        max: 3,
        marker: 'rule',
        color: overlay.onBase
      })
    ].join('')
  }

  if (theme.language === 'editorial') {
    return [
      chrome,
      imageFrame('Editorial image spread', 20, 25000),
      pictureXml,
      createTextBox(21, 'Editorial image figure', 760000, 1160000, 760000, 760000, [
        { text: String(index + 1).padStart(2, '0'), size: 39, color: theme.line, bold: true }
      ]),
      caption
        ? createTextBox(22, 'Editorial image caption', 1710000, 1200000, 3800000, 650000, [
            { text: caption, size: 18, color: theme.ink, bold: true }
          ])
        : '',
      createImagePointRows(slide.bullets, theme, {
        baseId: 40,
        name: 'Editorial image deck',
        x: 5940000,
        y: 1190000,
        width: 2520000,
        rowHeight: 310000,
        max: 3,
        marker: 'rule'
      })
    ].join('')
  }

  if (theme.language === 'playful') {
    return [
      chrome,
      createRect(20, 'Playful image activity lane', 620000, 1420000, 3580000, 3500000, theme.soft, null, 'roundRect'),
      imageFrame('Playful image window', 21, 65000),
      pictureXml,
      caption
        ? createTextBox(22, 'Playful image prompt', 940000, 1730000, 2920000, 600000, [
            { text: caption, size: 17, color: theme.ink, bold: true }
          ])
        : '',
      createImagePointRows(slide.bullets, theme, {
        baseId: 40,
        name: 'Playful image activity',
        x: 940000,
        y: 2560000,
        width: 2920000,
        rowHeight: 520000,
        max: 4,
        marker: 'tile'
      })
    ].join('')
  }

  if (theme.language === 'organic') {
    return [
      chrome,
      createRect(20, 'Organic image narrative band', 620000, 1470000, 2910000, 3210000, theme.soft, null, 'roundRect'),
      imageFrame('Organic image portrait', 21, 70000),
      pictureXml,
      caption
        ? createTextBox(22, 'Organic image reflection', 950000, 1790000, 2220000, 690000, [
            { text: caption, size: 16, color: theme.ink, bold: true }
          ])
        : '',
      createImagePointRows(slide.bullets, theme, {
        baseId: 40,
        name: 'Organic image note',
        x: 950000,
        y: 2690000,
        width: 2220000,
        rowHeight: 500000,
        max: 4,
        marker: 'rule'
      })
    ].join('')
  }

  if (theme.language === 'premium') {
    const overlayInk = pptxContrastText(theme.deep)
    return [
      chrome,
      imageFrame('Premium image gallery', 20, 35000),
      pictureXml,
      caption
        ? createTextBox(21, 'Premium image preface', 1210000, 1170000, 6900000, 410000, [
            { text: caption, size: 14, color: theme.ink, bold: true }
          ])
        : '',
      createRect(22, 'Premium image legend field', 5150000, 3350000, 3000000, 1230000, theme.deep),
      createImagePointRows(slide.bullets, theme, {
        baseId: 40,
        name: 'Premium image legend',
        x: 5450000,
        y: 3520000,
        width: 2450000,
        rowHeight: 480000,
        max: 2,
        marker: 'rule',
        color: overlayInk
      })
    ].join('')
  }

  if (theme.language === 'minimal') {
    return [
      chrome,
      imageFrame('Minimal image plane', 20, 25000),
      pictureXml,
      caption
        ? createTextBox(21, 'Minimal image premise', 850000, 1570000, 3000000, 650000, [
            { text: caption, size: 17, color: theme.ink, bold: true }
          ])
        : '',
      createImagePointRows(slide.bullets, theme, {
        baseId: 40,
        name: 'Minimal image note',
        x: 850000,
        y: 2510000,
        width: 3000000,
        rowHeight: 560000,
        max: 3,
        marker: 'rule'
      })
    ].join('')
  }

  return [
    chrome,
    imageFrame('Classic image ledger', 20, 45000),
    pictureXml,
    caption
      ? createTextBox(21, 'Classic image caption', 760000, 1280000, 3700000, 560000, [
          { text: caption, size: 14, color: theme.ink, bold: true }
        ])
      : '',
    createImagePointRows(slide.bullets, theme, {
      baseId: 40,
      name: 'Classic image point',
      x: 760000,
      y: 2110000,
      width: 3700000,
      rowHeight: 560000,
      max: 4,
      marker: 'number'
    })
  ].join('')
}

function pptxImagePlacementToEmu(placement: PptxImagePlacement) {
  const toEmu = (value: number) => Math.round(value * 914400)
  return {
    x: toEmu(placement.x),
    y: toEmu(placement.y),
    width: toEmu(placement.width),
    height: toEmu(placement.height)
  }
}

function createImagePointRows(
  bullets: string[],
  theme: PptxTheme,
  options: {
    baseId: number
    name: string
    x: number
    y: number
    width: number
    rowHeight: number
    max: number
    marker: 'number' | 'rule' | 'bar' | 'tile'
    color?: string
  }
) {
  const color = options.color || theme.ink
  return bullets
    .slice(0, options.max)
    .map((bullet, bulletIndex) => {
      const y = options.y + bulletIndex * options.rowHeight
      const id = options.baseId + bulletIndex * 3
      const tone = theme.tones[bulletIndex % theme.tones.length]
      if (options.marker === 'tile') {
        return [
          createRect(
            id,
            `${options.name} tile ${bulletIndex + 1}`,
            options.x,
            y,
            options.width,
            options.rowHeight - 90000,
            tone.base,
            null,
            'roundRect'
          ),
          createTextBox(
            id + 1,
            `${options.name} text ${bulletIndex + 1}`,
            options.x + 210000,
            y + 85000,
            options.width - 420000,
            options.rowHeight - 250000,
            [{ text: bullet, size: 12.5, color: tone.onBase, bold: true }]
          )
        ].join('')
      }
      const marker =
        options.marker === 'number'
          ? createTextBox(id, `${options.name} number ${bulletIndex + 1}`, options.x, y + 40000, 390000, 260000, [
              {
                text: String(bulletIndex + 1).padStart(2, '0'),
                size: 12,
                color: options.color || tone.base,
                bold: true
              }
            ])
          : createRect(
              id,
              `${options.name} ${options.marker} ${bulletIndex + 1}`,
              options.x,
              y + 90000,
              options.marker === 'bar' ? 300000 : 110000,
              options.marker === 'bar' ? 65000 : 180000,
              tone.base,
              null,
              options.marker === 'rule' ? 'rect' : 'roundRect'
            )
      return [
        marker,
        createTextBox(
          id + 1,
          `${options.name} text ${bulletIndex + 1}`,
          options.x + (options.marker === 'number' ? 450000 : 390000),
          y + 25000,
          options.width - (options.marker === 'number' ? 450000 : 390000),
          options.rowHeight - 90000,
          [{ text: bullet, size: 12.5, color, bold: bulletIndex === 0 }]
        )
      ].join('')
    })
    .join('')
}

function usesExpressiveComposition(theme: PptxTheme) {
  return ['brand', 'editorial', 'playful', 'organic', 'minimal'].includes(theme.language)
}

function createKineticCoverSlideXml(slide: NormalizedSlide, index: number, total: number, theme: PptxTheme) {
  const stage = theme.tones[1]
  const tags = slide.bullets
    .slice(0, 3)
    .map((bullet, bulletIndex) =>
      createTextBox(
        30 + bulletIndex,
        `Kinetic cover cue ${bulletIndex + 1}`,
        720000 + bulletIndex * 1580000,
        4250000,
        1380000,
        300000,
        [{ text: bullet, size: 11.5, color: theme.muted, bold: true }]
      )
    )
    .join('')
  return [
    createRect(2, 'Background', 0, 0, PPTX_SLIDE_W, PPTX_SLIDE_H, theme.bg),
    createRect(3, 'Kinetic cover stage', 5960000, 0, 3184000, PPTX_SLIDE_H, stage.base),
    createRect(4, 'Kinetic cover sweep', 5220000, 610000, 3180000, 3480000, theme.soft),
    createRect(5, 'Kinetic cover signal', 0, 0, 240000, PPTX_SLIDE_H, theme.base),
    createRect(6, 'Kinetic cover pulse large', 6880000, 980000, 1120000, 1120000, theme.tones[2].base, null, 'ellipse'),
    createRect(7, 'Kinetic cover pulse small', 6430000, 2740000, 520000, 520000, theme.base, null, 'ellipse'),
    slide.subtitle
      ? createTextBox(8, 'Kinetic cover kicker', 720000, 650000, 4300000, 320000, [
          { text: slide.subtitle, size: 14, color: theme.base, bold: true }
        ])
      : '',
    createTextBox(9, 'Kinetic cover title', 720000, 1220000, 4520000, 1680000, [
      { text: slide.title, size: 39, color: theme.ink, bold: true }
    ]),
    slide.takeaway
      ? createTextBox(10, 'Kinetic cover statement', 750000, 3220000, 4200000, 520000, [
          { text: slide.takeaway, size: 14.5, color: theme.muted, bold: true }
        ])
      : '',
    createTextBox(11, 'Kinetic cover folio', 7590000, 3690000, 820000, 650000, [
      { text: String(index + 1).padStart(2, '0'), size: 36, color: stage.onBase, bold: true }
    ]),
    tags,
    createFooter(index, total, stage.onBase)
  ].join('')
}

function createSpatialCoverSlideXml(slide: NormalizedSlide, index: number, total: number, theme: PptxTheme) {
  const tags = slide.bullets
    .slice(0, 3)
    .map((bullet, bulletIndex) =>
      createTextBox(
        30 + bulletIndex,
        `Spatial cover note ${bulletIndex + 1}`,
        5350000,
        1640000 + bulletIndex * 650000,
        2500000,
        330000,
        [{ text: bullet, size: 12, color: theme.ink, bold: bulletIndex === 0 }]
      )
    )
    .join('')
  return [
    createRect(2, 'Background', 0, 0, PPTX_SLIDE_W, PPTX_SLIDE_H, theme.bg),
    createRect(3, 'Spatial cover frame', 4820000, 520000, 3570000, 3980000, theme.card, theme.line),
    createRect(4, 'Spatial cover plane', 5180000, 900000, 2850000, 2900000, theme.soft),
    createRect(5, 'Spatial cover axis', 4470000, 520000, 32000, 3980000, theme.base),
    createTextBox(6, 'Spatial cover folio', 7520000, 720000, 620000, 500000, [
      { text: String(index + 1).padStart(2, '0'), size: 27, color: theme.base, bold: true }
    ]),
    slide.subtitle
      ? createTextBox(7, 'Spatial cover kicker', 700000, 760000, 3500000, 320000, [
          { text: slide.subtitle, size: 13.5, color: theme.base, bold: true }
        ])
      : '',
    createTextBox(8, 'Spatial cover title', 700000, 1370000, 3500000, 1600000, [
      { text: slide.title, size: 35, color: theme.ink, bold: true }
    ]),
    slide.takeaway
      ? createTextBox(9, 'Spatial cover statement', 730000, 3300000, 3440000, 620000, [
          { text: slide.takeaway, size: 14, color: theme.muted }
        ])
      : '',
    tags,
    createFooter(index, total, theme.muted)
  ].join('')
}

function createCoverSlideXml(slide: NormalizedSlide, index: number, total: number, theme: PptxTheme) {
  const tagColor = theme.coverInk
  const tagXml = slide.bullets
    .slice(0, 3)
    .map((bullet, i) =>
      createTextBox(20 + i, `Tag ${i + 1}`, 610000 + i * 2600000, 4140000, 2260000, 360000, [
        { text: bullet, size: 12, color: tagColor, bold: true }
      ])
    )
    .join('')
  const lightTagXml = slide.bullets
    .slice(0, 3)
    .map((bullet, i) =>
      createTextBox(40 + i, `Context ${i + 1}`, 760000 + i * 2500000, 4210000, 2140000, 300000, [
        { text: bullet, size: 11.5, color: theme.muted, bold: true }
      ])
    )
    .join('')

  if (theme.composition === 'kinetic' && usesExpressiveComposition(theme)) {
    return createKineticCoverSlideXml(slide, index, total, theme)
  }
  if (theme.composition === 'spatial' && usesExpressiveComposition(theme)) {
    return createSpatialCoverSlideXml(slide, index, total, theme)
  }

  if (theme.language === 'consulting') {
    return [
      createRect(2, 'Background', 0, 0, PPTX_SLIDE_W, PPTX_SLIDE_H, theme.bg),
      createTextBox(3, 'Consulting cover index', 520000, 620000, 1500000, 1150000, [
        { text: '01', size: 58, color: theme.soft, bold: true }
      ]),
      createRect(4, 'Consulting cover divider', 1960000, 700000, 42000, 3080000, theme.base),
      slide.subtitle
        ? createTextBox(6, 'Kicker', 2350000, 760000, 5300000, 320000, [
            { text: slide.subtitle, size: 14, color: theme.base, bold: true }
          ])
        : '',
      createTextBox(7, 'Title', 2350000, 1280000, 5750000, 1500000, [
        { text: slide.title, size: 35, color: theme.ink, bold: true }
      ]),
      slide.takeaway
        ? createTextBox(8, 'Takeaway', 2380000, 3150000, 5300000, 500000, [
            { text: slide.takeaway, size: 14, color: theme.muted }
          ])
        : '',
      lightTagXml,
      createFooter(index, total, theme.muted)
    ].join('')
  }

  if (theme.language === 'technical' || theme.language === 'data') {
    return [
      createRect(2, 'Background', 0, 0, PPTX_SLIDE_W, PPTX_SLIDE_H, theme.coverBg),
      createRect(3, 'Technical frame', 520000, 420000, 8100000, 4210000, theme.coverBg, theme.line),
      createRect(4, 'Technical corner horizontal', 520000, 420000, 980000, 65000, theme.base),
      createRect(5, 'Technical corner vertical', 520000, 420000, 65000, 720000, theme.base),
      createRect(9, 'Technical signal one', 7620000, 660000, 420000, 90000, theme.tones[0].base),
      createRect(10, 'Technical signal two', 8110000, 660000, 260000, 90000, theme.tones[1].base),
      slide.subtitle
        ? createTextBox(6, 'Kicker', 880000, 860000, 6200000, 320000, [
            { text: slide.subtitle, size: 14, color: theme.base, bold: true }
          ])
        : '',
      createTextBox(7, 'Title', 880000, 1370000, 7000000, 1450000, [
        { text: slide.title, size: 36, color: theme.coverInk, bold: true }
      ]),
      slide.takeaway
        ? createTextBox(8, 'Takeaway', 910000, 3240000, 6100000, 480000, [
            { text: slide.takeaway, size: 14, color: theme.coverMuted }
          ])
        : '',
      tagXml,
      createFooter(index, total, theme.coverMuted)
    ].join('')
  }

  if (theme.language === 'premium') {
    return [
      createRect(2, 'Background', 0, 0, PPTX_SLIDE_W, PPTX_SLIDE_H, theme.coverBg),
      createRect(3, 'Premium rule top', 850000, 640000, 7440000, 26000, theme.base),
      createRect(4, 'Premium rule short', 850000, 3650000, 1200000, 38000, theme.base),
      slide.subtitle
        ? createTextBox(6, 'Kicker', 880000, 980000, 6100000, 300000, [
            { text: slide.subtitle, size: 13, color: theme.base, bold: true }
          ])
        : '',
      createTextBox(7, 'Title', 880000, 1500000, 7040000, 1350000, [
        { text: slide.title, size: 37, color: theme.coverInk, bold: true }
      ]),
      slide.takeaway
        ? createTextBox(8, 'Takeaway', 900000, 3000000, 6000000, 420000, [
            { text: slide.takeaway, size: 13.5, color: theme.coverMuted }
          ])
        : '',
      tagXml,
      createFooter(index, total, theme.coverMuted)
    ].join('')
  }

  if (theme.language === 'bold' || theme.language === 'brand') {
    const field = theme.language === 'brand' ? theme.tones[1].base : theme.base
    const fieldInk = pptxContrastText(field)
    return [
      createRect(2, 'Background', 0, 0, PPTX_SLIDE_W, PPTX_SLIDE_H, theme.coverBg),
      createRect(3, 'Bold color field', 0, 0, 6550000, PPTX_SLIDE_H, field),
      createRect(4, 'Bold secondary field', 6550000, 0, 2594000, PPTX_SLIDE_H, theme.deep),
      createRect(5, 'Bold accent tile', 7150000, 700000, 1200000, 1200000, theme.tones[2].base),
      slide.subtitle
        ? createTextBox(6, 'Kicker', 700000, 720000, 5000000, 320000, [
            { text: slide.subtitle, size: 15, color: fieldInk, bold: true }
          ])
        : '',
      createTextBox(7, 'Title', 700000, 1320000, 5200000, 1580000, [
        { text: slide.title, size: 39, color: fieldInk, bold: true }
      ]),
      slide.takeaway
        ? createTextBox(8, 'Takeaway', 730000, 3300000, 5000000, 500000, [
            { text: slide.takeaway, size: 14, color: fieldInk }
          ])
        : '',
      createTextBox(9, 'Bold cover number', 7300000, 2520000, 1000000, 900000, [
        { text: String(index + 1).padStart(2, '0'), size: 48, color: theme.coverMuted, bold: true }
      ]),
      createFooter(index, total, theme.coverMuted)
    ].join('')
  }

  if (theme.language === 'executive' || theme.language === 'formal') {
    return [
      createRect(2, 'Background', 0, 0, PPTX_SLIDE_W, PPTX_SLIDE_H, theme.coverBg),
      createRect(3, 'Executive cover rail', 0, 0, 180000, PPTX_SLIDE_H, theme.base),
      createRect(4, 'Executive cover rule', 760000, 760000, 1300000, 42000, theme.base),
      slide.subtitle
        ? createTextBox(6, 'Kicker', 760000, 930000, 5800000, 320000, [
            { text: slide.subtitle, size: 14, color: theme.base, bold: true }
          ])
        : '',
      createTextBox(7, 'Title', 760000, 1430000, 6500000, 1430000, [
        { text: slide.title, size: 36, color: theme.coverInk, bold: true }
      ]),
      slide.takeaway
        ? createTextBox(8, 'Takeaway', 790000, 3250000, 5600000, 500000, [
            { text: slide.takeaway, size: 14, color: theme.coverMuted }
          ])
        : '',
      createTextBox(9, 'Executive cover folio', 7600000, 900000, 900000, 720000, [
        { text: String(index + 1).padStart(2, '0'), size: 38, color: theme.base, bold: true }
      ]),
      tagXml,
      createFooter(index, total, theme.coverMuted)
    ].join('')
  }

  if (theme.language === 'product') {
    return [
      createRect(2, 'Background', 0, 0, PPTX_SLIDE_W, PPTX_SLIDE_H, theme.bg),
      createRect(3, 'Product color canvas', 6260000, 0, 2884000, PPTX_SLIDE_H, theme.soft),
      createRect(4, 'Product focus circle', 6850000, 960000, 1550000, 1550000, theme.base, null, 'ellipse'),
      createRect(5, 'Product accent circle', 7760000, 2450000, 620000, 620000, theme.tones[2].base, null, 'ellipse'),
      slide.subtitle
        ? createTextBox(6, 'Kicker', 720000, 820000, 4700000, 320000, [
            { text: slide.subtitle, size: 14, color: theme.base, bold: true }
          ])
        : '',
      createTextBox(7, 'Title', 720000, 1390000, 5000000, 1420000, [
        { text: slide.title, size: 36, color: theme.ink, bold: true }
      ]),
      slide.takeaway
        ? createTextBox(8, 'Takeaway', 750000, 3250000, 4800000, 480000, [
            { text: slide.takeaway, size: 14, color: theme.muted }
          ])
        : '',
      lightTagXml,
      createFooter(index, total, theme.muted)
    ].join('')
  }

  if (theme.variant === 'minimal' || theme.variant === 'editorial') {
    return [
      createRect(2, 'Background', 0, 0, PPTX_SLIDE_W, PPTX_SLIDE_H, theme.bg),
      createRect(3, 'Accent line', 0, 0, PPTX_SLIDE_W, theme.variant === 'editorial' ? 150000 : 70000, theme.base),
      createRect(
        4,
        'Editorial marker',
        680000,
        1050000,
        theme.variant === 'editorial' ? 1100000 : 520000,
        70000,
        theme.base
      ),
      slide.subtitle
        ? createTextBox(6, 'Kicker', 680000, 650000, 6500000, 320000, [
            { text: slide.subtitle, size: 14, color: theme.base, bold: true }
          ])
        : '',
      createTextBox(7, 'Title', 680000, 1260000, 7600000, 1420000, [
        { text: slide.title, size: theme.variant === 'editorial' ? 38 : 34, color: theme.ink, bold: true }
      ]),
      slide.takeaway
        ? createTextBox(8, 'Takeaway', 710000, 3150000, 6800000, 520000, [
            { text: slide.takeaway || '', size: 15, color: theme.muted }
          ])
        : '',
      createFooter(index, total, theme.muted),
      tagXml
    ].join('')
  }

  if (theme.variant === 'playful' || theme.variant === 'organic') {
    return [
      createRect(2, 'Background', 0, 0, PPTX_SLIDE_W, PPTX_SLIDE_H, theme.bg),
      createRect(3, 'Playful orbit large', 7440000, 0, 1700000, 1700000, theme.soft, null, 'ellipse'),
      createRect(4, 'Playful orbit accent', 7420000, 700000, 760000, 760000, theme.tones[1].base, null, 'ellipse'),
      createRect(5, 'Playful orbit small', 8240000, 1620000, 330000, 330000, theme.tones[2].base, null, 'ellipse'),
      slide.subtitle
        ? createTextBox(6, 'Kicker', 820000, 760000, 5600000, 320000, [
            { text: slide.subtitle, size: 15, color: theme.base, bold: true }
          ])
        : '',
      createTextBox(7, 'Title', 820000, 1250000, 6200000, 1420000, [
        { text: slide.title, size: 34, color: theme.ink, bold: true }
      ]),
      slide.takeaway
        ? createRect(8, 'Takeaway panel', 790000, 3180000, 6000000, 640000, theme.soft, theme.soft, 'roundRect')
        : '',
      slide.takeaway
        ? createTextBox(9, 'Takeaway', 1080000, 3350000, 5400000, 300000, [
            { text: slide.takeaway || '', size: 14, color: theme.text, bold: true }
          ])
        : '',
      createFooter(index, total, theme.muted),
      tagXml
    ].join('')
  }

  return [
    createRect(2, 'Background', 0, 0, PPTX_SLIDE_W, PPTX_SLIDE_H, theme.coverBg),
    createRect(3, 'Corporate cover rule', 680000, 650000, 1520000, 44000, theme.base),
    createRect(4, 'Corporate cover spine', 6900000, 650000, 36000, 3550000, theme.line),
    createTextBox(5, 'Corporate cover folio', 7300000, 770000, 1100000, 820000, [
      { text: String(index + 1).padStart(2, '0'), size: 44, color: theme.soft, bold: true }
    ]),
    createRect(13, 'Corporate signal one', 7300000, 2110000, 1080000, 70000, theme.tones[0].base),
    createRect(14, 'Corporate signal two', 7300000, 2380000, 760000, 70000, theme.tones[1].base),
    createRect(15, 'Corporate signal three', 7300000, 2650000, 470000, 70000, theme.tones[2].base),
    slide.subtitle
      ? createTextBox(6, 'Kicker', 680000, 760000, 5200000, 320000, [
          { text: slide.subtitle, size: 15, color: theme.base, bold: true }
        ])
      : '',
    createTextBox(7, 'Title', 680000, 1290000, 5700000, 1450000, [
      { text: slide.title, size: 34, color: theme.coverInk, bold: true }
    ]),
    slide.takeaway
      ? createTextBox(8, 'Takeaway', 710000, 3210000, 5200000, 480000, [
          { text: slide.takeaway || '', size: 14, color: theme.muted }
        ])
      : '',
    createFooter(index, total, theme.coverMuted),
    tagXml
  ].join('')
}

function createKineticSectionSlideXml(slide: NormalizedSlide, index: number, total: number, theme: PptxTheme) {
  const subtitle = slide.subtitle || slide.takeaway || slide.bullets[0]
  const field = theme.tones[1]
  return [
    createRect(2, 'Background', 0, 0, PPTX_SLIDE_W, PPTX_SLIDE_H, theme.bg),
    createRect(3, 'Kinetic section runway', 0, 0, 3180000, PPTX_SLIDE_H, field.base),
    createRect(4, 'Kinetic section offset field', 3180000, 680000, 5200000, 3380000, theme.soft),
    createRect(5, 'Kinetic section signal', 7440000, 0, 1700000, 980000, theme.tones[2].base),
    createTextBox(6, 'Kinetic section folio', 760000, 780000, 1300000, 960000, [
      { text: String(index).padStart(2, '0'), size: 52, color: field.onBase, bold: true }
    ]),
    createTextBox(7, 'Kinetic section title', 3650000, 1420000, 4450000, 1320000, [
      { text: slide.title, size: 37, color: theme.ink, bold: true }
    ]),
    subtitle
      ? createTextBox(8, 'Kinetic section statement', 3680000, 3090000, 4100000, 540000, [
          { text: subtitle, size: 15, color: theme.muted, bold: true }
        ])
      : '',
    createFooter(index, total, theme.muted)
  ].join('')
}

function createSpatialSectionSlideXml(slide: NormalizedSlide, index: number, total: number, theme: PptxTheme) {
  const subtitle = slide.subtitle || slide.takeaway || slide.bullets[0]
  return [
    createRect(2, 'Background', 0, 0, PPTX_SLIDE_W, PPTX_SLIDE_H, theme.bg),
    createRect(3, 'Spatial section boundary', 660000, 570000, 7840000, 4000000, theme.bg, theme.line),
    createRect(4, 'Spatial section plane', 5450000, 890000, 2550000, 3050000, theme.soft),
    createTextBox(5, 'Spatial section folio', 5900000, 1190000, 1400000, 1050000, [
      { text: String(index).padStart(2, '0'), size: 55, color: theme.base, bold: true }
    ]),
    createRect(6, 'Spatial section axis', 760000, 1280000, 760000, 36000, theme.base),
    createTextBox(7, 'Spatial section title', 760000, 1530000, 4200000, 1280000, [
      { text: slide.title, size: 35, color: theme.ink, bold: true }
    ]),
    subtitle
      ? createTextBox(8, 'Spatial section statement', 790000, 3190000, 3900000, 520000, [
          { text: subtitle, size: 14.5, color: theme.muted }
        ])
      : '',
    createFooter(index, total, theme.muted)
  ].join('')
}

function createSectionSlideXml(slide: NormalizedSlide, index: number, total: number, theme: PptxTheme) {
  const subtitle = slide.subtitle || slide.takeaway || slide.bullets[0]
  if (theme.composition === 'kinetic' && usesExpressiveComposition(theme)) {
    return createKineticSectionSlideXml(slide, index, total, theme)
  }
  if (theme.composition === 'spatial' && usesExpressiveComposition(theme)) {
    return createSpatialSectionSlideXml(slide, index, total, theme)
  }
  if (theme.language === 'editorial' || theme.language === 'minimal' || theme.language === 'consulting') {
    return [
      createRect(2, 'Background', 0, 0, PPTX_SLIDE_W, PPTX_SLIDE_H, theme.bg),
      createTextBox(3, 'Section folio', 650000, 680000, 1800000, 1100000, [
        { text: String(index).padStart(2, '0'), size: 56, color: theme.soft, bold: true }
      ]),
      createRect(4, 'Section editorial rule', 2350000, 780000, 42000, 3180000, theme.base),
      createTextBox(5, 'Section title', 2800000, 1430000, 5100000, 1200000, [
        { text: slide.title, size: 35, color: theme.ink, bold: true }
      ]),
      subtitle
        ? createTextBox(6, 'Section subtitle', 2830000, 3030000, 4700000, 500000, [
            { text: subtitle, size: 15, color: theme.muted }
          ])
        : '',
      createFooter(index, total, theme.muted)
    ].join('')
  }
  if (theme.language === 'technical' || theme.language === 'data') {
    return [
      createRect(2, 'Background', 0, 0, PPTX_SLIDE_W, PPTX_SLIDE_H, theme.coverBg),
      createRect(3, 'Section technical frame', 550000, 500000, 8040000, 4120000, theme.coverBg, theme.line),
      createRect(4, 'Section technical signal', 550000, 500000, 1300000, 70000, theme.base),
      createTextBox(5, 'Section title', 900000, 1500000, 6500000, 1200000, [
        { text: slide.title, size: 35, color: theme.coverInk, bold: true }
      ]),
      subtitle
        ? createTextBox(6, 'Section subtitle', 930000, 3100000, 5700000, 460000, [
            { text: subtitle, size: 15, color: theme.coverMuted }
          ])
        : '',
      createTextBox(7, 'Section technical folio', 7590000, 840000, 700000, 520000, [
        { text: String(index).padStart(2, '0'), size: 28, color: theme.base, bold: true }
      ]),
      createFooter(index, total, theme.coverMuted)
    ].join('')
  }
  if (theme.language === 'bold' || theme.language === 'brand') {
    const tone = theme.tones[1]
    return [
      createRect(2, 'Background', 0, 0, PPTX_SLIDE_W, PPTX_SLIDE_H, tone.base),
      createRect(3, 'Section bold side field', 6730000, 0, 2414000, PPTX_SLIDE_H, theme.deep),
      createRect(4, 'Section bold accent', 7330000, 650000, 1050000, 1050000, theme.tones[2].base),
      createTextBox(5, 'Section title', 700000, 1420000, 5400000, 1280000, [
        { text: slide.title, size: 37, color: tone.onBase, bold: true }
      ]),
      subtitle
        ? createTextBox(6, 'Section subtitle', 730000, 3150000, 5000000, 480000, [
            { text: subtitle, size: 15, color: tone.onBase }
          ])
        : '',
      createTextBox(7, 'Section bold folio', 7440000, 2750000, 820000, 650000, [
        { text: String(index).padStart(2, '0'), size: 36, color: theme.coverMuted, bold: true }
      ]),
      createFooter(index, total, theme.coverMuted)
    ].join('')
  }
  if (theme.language === 'playful' || theme.language === 'organic') {
    return [
      createRect(2, 'Background', 0, 0, PPTX_SLIDE_W, PPTX_SLIDE_H, theme.bg),
      createRect(3, 'Section soft orbit', 5750000, 520000, 2850000, 2850000, theme.soft, null, 'ellipse'),
      createRect(4, 'Section accent orbit', 7280000, 2670000, 850000, 850000, theme.tones[1].base, null, 'ellipse'),
      createTextBox(5, 'Section title', 780000, 1430000, 5700000, 1260000, [
        { text: slide.title, size: 35, color: theme.ink, bold: true }
      ]),
      subtitle
        ? createTextBox(6, 'Section subtitle', 810000, 3150000, 4900000, 470000, [
            { text: subtitle, size: 15, color: theme.muted }
          ])
        : '',
      createTextBox(7, 'Section playful folio', 7000000, 1400000, 700000, 500000, [
        { text: String(index).padStart(2, '0'), size: 28, color: theme.tones[0].text, bold: true }
      ]),
      createFooter(index, total, theme.muted)
    ].join('')
  }
  if (theme.language === 'premium') {
    return [
      createRect(2, 'Background', 0, 0, PPTX_SLIDE_W, PPTX_SLIDE_H, theme.coverBg),
      createRect(3, 'Section premium top rule', 850000, 720000, 7440000, 26000, theme.base),
      createRect(4, 'Section premium short rule', 850000, 3760000, 1100000, 36000, theme.base),
      createTextBox(5, 'Section title', 850000, 1500000, 7000000, 1200000, [
        { text: slide.title, size: 36, color: theme.coverInk, bold: true }
      ]),
      subtitle
        ? createTextBox(6, 'Section subtitle', 880000, 3100000, 5800000, 460000, [
            { text: subtitle, size: 14.5, color: theme.coverMuted }
          ])
        : '',
      createFooter(index, total, theme.coverMuted)
    ].join('')
  }
  return [
    createRect(2, 'Background', 0, 0, PPTX_SLIDE_W, PPTX_SLIDE_H, theme.coverBg),
    createRect(3, 'Corporate section rule', 760000, 760000, 1200000, 42000, theme.base),
    createTextBox(4, 'Section label', 760000, 930000, 4200000, 320000, [
      { text: `PART ${String(index).padStart(2, '0')}`, size: 14, color: theme.base, bold: true }
    ]),
    createTextBox(5, 'Section title', 760000, 1500000, 6100000, 1260000, [
      { text: slide.title, size: 34, color: theme.coverInk, bold: true }
    ]),
    slide.subtitle || slide.takeaway || slide.bullets[0]
      ? createTextBox(6, 'Section subtitle', 790000, 3150000, 5200000, 500000, [
          { text: slide.subtitle || slide.takeaway || slide.bullets[0] || '', size: 16, color: theme.coverMuted }
        ])
      : '',
    createTextBox(7, 'Corporate section folio', 7140000, 1220000, 1200000, 1100000, [
      { text: String(index).padStart(2, '0'), size: 58, color: theme.soft, bold: true }
    ]),
    createRect(8, 'Corporate section spine', 6870000, 1050000, 32000, 2800000, theme.line),
    createFooter(index, total, theme.coverMuted)
  ].join('')
}

function createAgendaSlideXml(slide: NormalizedSlide, index: number, total: number, theme: PptxTheme) {
  const items = (slide.bullets.length ? slide.bullets : ['背景与目标', '关键洞察', '方案路径', '下一步行动']).slice(
    0,
    6
  )
  if (['consulting', 'formal', 'editorial', 'minimal'].includes(theme.language)) {
    const rows = items
      .map((item, i) => {
        const col = i % 2
        const row = Math.floor(i / 2)
        const x = 760000 + col * 4030000
        const y = 1840000 + row * 760000
        return [
          createTextBox(20 + i * 3, `Agenda folio ${i + 1}`, x, y, 600000, 360000, [
            { text: String(i + 1).padStart(2, '0'), size: 20, color: theme.base, bold: true }
          ]),
          createTextBox(21 + i * 3, `Agenda statement ${i + 1}`, x + 760000, y, 2900000, 380000, [
            { text: item, size: 14, color: theme.ink, bold: i === 0 }
          ]),
          createRect(22 + i * 3, `Agenda rule ${i + 1}`, x, y + 510000, 3550000, 22000, theme.line)
        ].join('')
      })
      .join('')
    return [createBaseSlideChrome(slide, index, total, theme), createTakeawayBand(slide, theme), rows].join('')
  }
  if (theme.language === 'bold' || theme.language === 'brand') {
    const rows = items
      .map((item, i) => {
        const col = i % 2
        const row = Math.floor(i / 2)
        const x = 650000 + col * 4070000
        const y = 1510000 + row * 890000
        const tone = theme.tones[i % theme.tones.length]
        return [
          createRect(20 + i * 3, `Agenda color strip ${i + 1}`, x, y, 3850000, 620000, tone.base),
          createTextBox(21 + i * 3, `Agenda color number ${i + 1}`, x + 230000, y + 140000, 480000, 260000, [
            { text: String(i + 1).padStart(2, '0'), size: 17, color: tone.onBase, bold: true }
          ]),
          createTextBox(22 + i * 3, `Agenda color text ${i + 1}`, x + 900000, y + 120000, 2670000, 300000, [
            { text: item, size: 13.5, color: tone.onBase, bold: true }
          ])
        ].join('')
      })
      .join('')
    return [createBaseSlideChrome(slide, index, total, theme), rows].join('')
  }
  if (theme.language === 'playful' || theme.language === 'organic') {
    const rows = items
      .map((item, i) => {
        const col = i % 2
        const row = Math.floor(i / 2)
        const x = 850000 + col * 4050000
        const y = 1840000 + row * 760000
        const tone = theme.tones[i % theme.tones.length]
        return [
          createRect(20 + i * 3, `Agenda bubble ${i + 1}`, x, y, 520000, 520000, tone.base, null, 'ellipse'),
          createTextBox(21 + i * 3, `Agenda bubble number ${i + 1}`, x + 145000, y + 145000, 230000, 200000, [
            { text: String(i + 1), size: 15, color: tone.onBase, bold: true }
          ]),
          createTextBox(22 + i * 3, `Agenda bubble text ${i + 1}`, x + 760000, y + 80000, 2750000, 360000, [
            { text: item, size: 14, color: theme.ink, bold: i === 0 }
          ])
        ].join('')
      })
      .join('')
    return [createBaseSlideChrome(slide, index, total, theme), createTakeawayBand(slide, theme), rows].join('')
  }
  const itemXml = items
    .map((item, i) => {
      const col = i % 2
      const row = Math.floor(i / 2)
      const x = 760000 + col * 4040000
      const y = 1510000 + row * 850000
      const tone = theme.tones[i % theme.tones.length]
      return [
        createTextBox(20 + i * 3, `Corporate agenda number ${i + 1}`, x, y, 620000, 390000, [
          { text: String(i + 1).padStart(2, '0'), size: 21, color: tone.base, bold: true }
        ]),
        createTextBox(21 + i * 3, `Corporate agenda text ${i + 1}`, x + 760000, y + 30000, 2840000, 340000, [
          { text: item, size: 14, color: theme.ink, bold: i === 0 }
        ]),
        createRect(22 + i * 3, `Corporate agenda rule ${i + 1}`, x, y + 500000, 3540000, 24000, theme.line)
      ].join('')
    })
    .join('')

  return [
    createBaseSlideChrome(slide, index, total, theme),
    slide.subtitle || slide.takeaway
      ? createTextBox(12, 'Subtitle', PPTX_MARGIN_X, 1120000, 7400000, 280000, [
          { text: slide.subtitle || slide.takeaway || '', size: 13, color: theme.muted }
        ])
      : '',
    itemXml
  ].join('')
}

function createCardsSlideXml(slide: NormalizedSlide, index: number, total: number, theme: PptxTheme) {
  const bullets = slide.bullets.slice(0, 4)
  if (['consulting', 'formal', 'editorial', 'minimal', 'executive', 'premium'].includes(theme.language)) {
    return createTypographicCardsSlideXml(slide, index, total, theme, bullets)
  }
  if (theme.language === 'bold' || theme.language === 'brand') {
    return createColorFieldCardsSlideXml(slide, index, total, theme, bullets)
  }
  if (theme.language === 'playful' || theme.language === 'organic') {
    return createStaggeredCardsSlideXml(slide, index, total, theme, bullets)
  }
  if (theme.language === 'technical' || theme.language === 'data') {
    return createTechnicalCardsSlideXml(slide, index, total, theme, bullets)
  }
  return createNarrativeCardsSlideXml(slide, index, total, theme, bullets)
}

function createNarrativeCardsSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  theme: PptxTheme,
  bullets: string[]
) {
  const cards = (bullets.length ? bullets : ['核心方向']).map(parseCardBullet)
  if (cards.length <= 2) {
    const columns = cards.map((card, i) => {
      const x = 780000 + i * 3910000
      const tone = theme.tones[i % theme.tones.length]
      return [
        createTextBox(20 + i * 4, `Narrative folio ${i + 1}`, x, 1840000, 760000, 520000, [
          { text: String(i + 1).padStart(2, '0'), size: 28, color: tone.base, bold: true }
        ]),
        createTextBox(21 + i * 4, `Narrative heading ${i + 1}`, x, 2490000, 3320000, 430000, [
          { text: card.heading, size: 17, color: theme.ink, bold: true }
        ]),
        card.detail
          ? createTextBox(22 + i * 4, `Narrative detail ${i + 1}`, x, 3100000, 3320000, 720000, [
              { text: card.detail, size: 12, color: theme.muted }
            ])
          : '',
        createRect(23 + i * 4, `Narrative rule ${i + 1}`, x, 4020000, 1380000, 36000, tone.base)
      ].join('')
    })
    return [createBaseSlideChrome(slide, index, total, theme), createTakeawayBand(slide, theme), columns.join('')].join(
      ''
    )
  }

  const lead = cards[0]
  const supporting = cards.slice(1, 4).map((card, i) => {
    const y = 1810000 + i * 760000
    const tone = theme.tones[(i + 1) % theme.tones.length]
    return [
      createTextBox(30 + i * 4, `Narrative support number ${i + 2}`, 4660000, y, 560000, 320000, [
        { text: String(i + 2).padStart(2, '0'), size: 16, color: tone.base, bold: true }
      ]),
      createTextBox(31 + i * 4, `Narrative support heading ${i + 2}`, 5350000, y, 2820000, 330000, [
        { text: card.heading, size: 14, color: theme.ink, bold: true }
      ]),
      card.detail
        ? createTextBox(32 + i * 4, `Narrative support detail ${i + 2}`, 5350000, y + 350000, 2820000, 270000, [
            { text: card.detail, size: 10.5, color: theme.muted }
          ])
        : '',
      createRect(33 + i * 4, `Narrative support rule ${i + 2}`, 4660000, y + 630000, 3500000, 22000, theme.line)
    ].join('')
  })

  return [
    createBaseSlideChrome(slide, index, total, theme),
    createTakeawayBand(slide, theme),
    createRect(20, 'Narrative lead field', 720000, 1810000, 3400000, 2250000, theme.soft, null, theme.shape),
    createTextBox(21, 'Narrative lead folio', 1040000, 2090000, 700000, 430000, [
      { text: '01', size: 24, color: theme.base, bold: true }
    ]),
    createTextBox(22, 'Narrative lead heading', 1040000, 2700000, 2730000, 420000, [
      { text: lead.heading, size: 18, color: theme.ink, bold: true }
    ]),
    lead.detail
      ? createTextBox(23, 'Narrative lead detail', 1040000, 3290000, 2730000, 520000, [
          { text: lead.detail, size: 11.5, color: theme.muted }
        ])
      : '',
    supporting.join('')
  ].join('')
}

function createTypographicCardsSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  theme: PptxTheme,
  bullets: string[]
) {
  const rows = bullets
    .map((bullet, i) => {
      const card = parseCardBullet(bullet)
      const y = 1840000 + i * 610000
      return [
        createTextBox(20 + i * 4, `Editorial number ${i + 1}`, 760000, y, 620000, 340000, [
          { text: String(i + 1).padStart(2, '0'), size: 19, color: theme.base, bold: true }
        ]),
        createTextBox(21 + i * 4, `Editorial heading ${i + 1}`, 1520000, y, 2100000, 340000, [
          { text: card.heading, size: 14, color: theme.ink, bold: true }
        ]),
        card.detail
          ? createTextBox(22 + i * 4, `Editorial detail ${i + 1}`, 3820000, y, 4300000, 360000, [
              { text: card.detail, size: 11.5, color: theme.muted }
            ])
          : '',
        createRect(23 + i * 4, `Editorial row rule ${i + 1}`, 760000, y + 440000, 7560000, 24000, theme.line)
      ].join('')
    })
    .join('')
  return [createBaseSlideChrome(slide, index, total, theme), createTakeawayBand(slide, theme), rows].join('')
}

function createColorFieldCardsSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  theme: PptxTheme,
  bullets: string[]
) {
  const count = Math.max(1, bullets.length)
  const twoRows = count === 4
  const width = twoRows ? 3700000 : Math.floor(7440000 / count) - 120000
  const height = twoRows ? 1120000 : 2140000
  const tiles = bullets
    .map((bullet, i) => {
      const card = parseCardBullet(bullet)
      const col = twoRows ? i % 2 : i
      const row = twoRows ? Math.floor(i / 2) : 0
      const x = 760000 + col * (width + (twoRows ? 260000 : 120000))
      const y = 1840000 + row * 1320000
      const tone = theme.tones[i % theme.tones.length]
      const headingX = twoRows ? x + 820000 : x + 220000
      const headingY = twoRows ? y + 170000 : y + 580000
      const headingWidth = twoRows ? width - 1060000 : width - 440000
      const detailX = twoRows ? x + 820000 : x + 220000
      const detailY = twoRows ? y + 610000 : y + 1120000
      const detailWidth = twoRows ? width - 1060000 : width - 440000
      const detailHeight = twoRows ? height - 740000 : height - 1320000
      return [
        createRect(20 + i * 4, `Bold idea field ${i + 1}`, x, y, width, height, tone.base),
        createTextBox(21 + i * 4, `Bold idea number ${i + 1}`, x + 220000, y + 180000, 480000, 320000, [
          { text: String(i + 1).padStart(2, '0'), size: 18, color: tone.onBase, bold: true }
        ]),
        createTextBox(22 + i * 4, `Bold idea heading ${i + 1}`, headingX, headingY, headingWidth, 360000, [
          { text: card.heading, size: 15, color: tone.onBase, bold: true }
        ]),
        card.detail
          ? createTextBox(23 + i * 4, `Bold idea detail ${i + 1}`, detailX, detailY, detailWidth, detailHeight, [
              { text: card.detail, size: 11, color: tone.onBase }
            ])
          : ''
      ].join('')
    })
    .join('')
  return [createBaseSlideChrome(slide, index, total, theme), createTakeawayBand(slide, theme), tiles].join('')
}

function createStaggeredCardsSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  theme: PptxTheme,
  bullets: string[]
) {
  const count = Math.max(1, bullets.length)
  const width = count === 4 ? 3600000 : Math.floor(7350000 / count) - 160000
  const tiles = bullets
    .map((bullet, i) => {
      const card = parseCardBullet(bullet)
      const twoRows = count === 4
      const col = twoRows ? i % 2 : i
      const row = twoRows ? Math.floor(i / 2) : 0
      const x = 870000 + col * (width + (twoRows ? 330000 : 160000))
      const y = 1920000 + row * 1280000 + (!twoRows && i % 2 === 1 ? 240000 : 0)
      const height = twoRows ? 1050000 : 1900000
      const tone = theme.tones[i % theme.tones.length]
      return [
        createRect(20 + i * 5, `Staggered idea ${i + 1}`, x, y, width, height, tone.soft, null, 'roundRect'),
        createRect(
          21 + i * 5,
          `Staggered number bubble ${i + 1}`,
          x + 210000,
          y + 200000,
          430000,
          430000,
          tone.base,
          null,
          'ellipse'
        ),
        createTextBox(22 + i * 5, `Staggered number ${i + 1}`, x + 310000, y + 305000, 220000, 180000, [
          { text: String(i + 1), size: 14, color: tone.onBase, bold: true }
        ]),
        createTextBox(23 + i * 5, `Staggered heading ${i + 1}`, x + 780000, y + 200000, width - 1030000, 380000, [
          { text: card.heading, size: 14, color: theme.ink, bold: true }
        ]),
        card.detail
          ? createTextBox(
              24 + i * 5,
              `Staggered detail ${i + 1}`,
              x + 260000,
              y + 720000,
              width - 520000,
              height - 900000,
              [{ text: card.detail, size: 11, color: theme.muted }]
            )
          : ''
      ].join('')
    })
    .join('')
  return [createBaseSlideChrome(slide, index, total, theme), createTakeawayBand(slide, theme), tiles].join('')
}

function createTechnicalCardsSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  theme: PptxTheme,
  bullets: string[]
) {
  const count = Math.max(1, bullets.length)
  const columns = count === 4 ? 2 : count
  const width = columns === 2 ? 3680000 : 2380000
  const height = count === 4 ? 1120000 : 1950000
  const modules = bullets
    .map((bullet, i) => {
      const card = parseCardBullet(bullet)
      const col = i % columns
      const row = Math.floor(i / columns)
      const x = 800000 + col * (width + 360000)
      const y = 1850000 + row * 1320000
      const tone = theme.tones[i % theme.tones.length]
      return [
        createRect(20 + i * 5, `Technical module ${i + 1}`, x, y, width, height, theme.card, theme.line),
        createRect(21 + i * 5, `Technical module signal ${i + 1}`, x, y, width, 85000, tone.base),
        createTextBox(22 + i * 5, `Technical module index ${i + 1}`, x + 220000, y + 230000, 540000, 260000, [
          { text: String(i + 1).padStart(2, '0'), size: 15, color: tone.base, bold: true }
        ]),
        createTextBox(
          23 + i * 5,
          `Technical module heading ${i + 1}`,
          x + 830000,
          y + 210000,
          width - 1080000,
          360000,
          [{ text: card.heading, size: 13.5, color: theme.ink, bold: true }]
        ),
        card.detail
          ? createTextBox(
              24 + i * 5,
              `Technical module detail ${i + 1}`,
              x + 230000,
              y + 700000,
              width - 460000,
              height - 900000,
              [{ text: card.detail, size: 10.5, color: theme.muted }]
            )
          : ''
      ].join('')
    })
    .join('')
  return [createBaseSlideChrome(slide, index, total, theme), createTakeawayBand(slide, theme), modules].join('')
}

function createKineticInsightSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  theme: PptxTheme,
  bullets: string[]
) {
  const statement = slide.takeaway || slide.subtitle || bullets[0] || slide.title
  const evidence = (bullets[0] === statement ? bullets.slice(1) : bullets).slice(0, 4)
  const rows = evidence
    .map((bullet, bulletIndex) => {
      const x = 4560000 + (bulletIndex % 2) * 180000
      const y = 1450000 + bulletIndex * 720000
      const tone = theme.tones[bulletIndex % theme.tones.length]
      return [
        createRect(30 + bulletIndex * 3, `Kinetic insight bar ${bulletIndex + 1}`, x, y, 3380000, 500000, tone.soft),
        createRect(31 + bulletIndex * 3, `Kinetic insight signal ${bulletIndex + 1}`, x, y, 120000, 500000, tone.base),
        createTextBox(
          32 + bulletIndex * 3,
          `Kinetic insight evidence ${bulletIndex + 1}`,
          x + 330000,
          y + 85000,
          2820000,
          280000,
          [{ text: bullet, size: 12.5, color: theme.ink, bold: bulletIndex === 0 }]
        )
      ].join('')
    })
    .join('')
  const field = theme.tones[1]
  return [
    createBaseSlideChrome(slide, index, total, theme),
    createRect(10, 'Kinetic insight statement field', 520000, 1300000, 3480000, 3220000, field.base),
    createRect(11, 'Kinetic insight accent tile', 520000, 1300000, 730000, 370000, theme.tones[2].base),
    createTextBox(12, 'Kinetic insight statement', 900000, 1880000, 2750000, 1760000, [
      { text: statement, size: 24, color: field.onBase, bold: true }
    ]),
    rows
  ].join('')
}

function createSpatialInsightSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  theme: PptxTheme,
  bullets: string[]
) {
  const statement = slide.takeaway || slide.subtitle || bullets[0] || slide.title
  const evidence = (bullets[0] === statement ? bullets.slice(1) : bullets).slice(0, 4)
  const rows = evidence
    .map((bullet, bulletIndex) => {
      const column = bulletIndex % 2
      const row = Math.floor(bulletIndex / 2)
      const x = 4510000 + column * 1950000
      const y = 1810000 + row * 1250000
      const tone = theme.tones[bulletIndex % theme.tones.length]
      return [
        createRect(
          30 + bulletIndex * 3,
          `Spatial insight node ${bulletIndex + 1}`,
          x,
          y,
          330000,
          330000,
          tone.base,
          null,
          'ellipse'
        ),
        createTextBox(
          31 + bulletIndex * 3,
          `Spatial insight evidence ${bulletIndex + 1}`,
          x,
          y + 470000,
          1650000,
          540000,
          [{ text: bullet, size: 12, color: theme.ink, bold: bulletIndex === 0 }]
        ),
        createRect(
          32 + bulletIndex * 3,
          `Spatial insight axis ${bulletIndex + 1}`,
          x + 470000,
          y + 145000,
          1200000,
          22000,
          theme.line
        )
      ].join('')
    })
    .join('')
  return [
    createBaseSlideChrome(slide, index, total, theme),
    createRect(10, 'Spatial insight field', 690000, 1450000, 3300000, 2780000, theme.bg, theme.line),
    createRect(11, 'Spatial insight plane', 690000, 1450000, 820000, 2780000, theme.soft),
    createTextBox(12, 'Spatial insight statement', 1110000, 1940000, 2520000, 1600000, [
      { text: statement, size: 23, color: theme.ink, bold: true }
    ]),
    rows
  ].join('')
}

function createInsightSlideXml(slide: NormalizedSlide, index: number, total: number, theme: PptxTheme) {
  const bullets = slide.bullets.slice(0, 5)
  if (theme.composition === 'kinetic' && usesExpressiveComposition(theme)) {
    return createKineticInsightSlideXml(slide, index, total, theme, bullets)
  }
  if (theme.composition === 'spatial' && usesExpressiveComposition(theme)) {
    return createSpatialInsightSlideXml(slide, index, total, theme, bullets)
  }
  if (
    ['classic', 'executive', 'consulting', 'formal', 'product', 'editorial', 'premium', 'minimal'].includes(
      theme.language
    )
  ) {
    return createSplitInsightSlideXml(slide, index, total, theme, bullets)
  }
  if (theme.language === 'bold' || theme.language === 'brand') {
    return createBoldInsightSlideXml(slide, index, total, theme, bullets)
  }
  if (theme.language === 'playful' || theme.language === 'organic') {
    return createOrganicInsightSlideXml(slide, index, total, theme, bullets)
  }
  if (theme.language === 'technical' || theme.language === 'data') {
    return createTechnicalInsightSlideXml(slide, index, total, theme, bullets)
  }
  const bulletXml = bullets
    .map((bullet, i) => {
      const y = 2100000 + i * 470000
      return [
        createRect(
          30 + i * 3,
          `Point marker ${i + 1}`,
          760000,
          y + 64000,
          180000,
          180000,
          theme.base,
          theme.base,
          'ellipse'
        ),
        createTextBox(31 + i * 3, `Point ${i + 1}`, 1070000, y, 6500000, 280000, [
          { text: bullet, size: 14, color: theme.ink }
        ])
      ].join('')
    })
    .join('')

  return [
    createBaseSlideChrome(slide, index, total, theme),
    createRect(10, 'Takeaway panel', 720000, 1180000, 7600000, 620000, theme.soft, theme.soft, theme.shape),
    createTextBox(11, 'Takeaway', 1020000, 1350000, 7000000, 280000, [
      { text: slide.takeaway || slide.subtitle || bullets[0] || slide.title, size: 16, color: theme.text, bold: true }
    ]),
    bulletXml
  ].join('')
}

function createSplitInsightSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  theme: PptxTheme,
  bullets: string[]
) {
  const statement = slide.takeaway || slide.subtitle || bullets[0] || slide.title
  const evidence = bullets[0] === statement ? bullets.slice(1) : bullets
  const rows = evidence.slice(0, 4).map((bullet, i) => {
    const y = 1560000 + i * 650000
    return [
      createTextBox(30 + i * 3, `Evidence index ${i + 1}`, 4720000, y, 520000, 300000, [
        { text: String(i + 1).padStart(2, '0'), size: 15, color: theme.base, bold: true }
      ]),
      createTextBox(31 + i * 3, `Evidence text ${i + 1}`, 5400000, y, 2920000, 360000, [
        { text: bullet, size: 12.5, color: theme.ink, bold: i === 0 }
      ]),
      createRect(32 + i * 3, `Evidence rule ${i + 1}`, 4720000, y + 440000, 3600000, 22000, theme.line)
    ].join('')
  })
  return [
    createBaseSlideChrome(slide, index, total, theme),
    createRect(10, 'Statement spine', 760000, 1430000, 62000, 2330000, theme.base),
    createTextBox(11, 'Primary statement', 1110000, 1500000, 3150000, 1900000, [
      { text: statement, size: 24, color: theme.ink, bold: true }
    ]),
    slide.subtitle && slide.subtitle !== statement
      ? createTextBox(12, 'Statement context', 1130000, 3480000, 3000000, 380000, [
          { text: slide.subtitle, size: 11.5, color: theme.muted }
        ])
      : '',
    rows.join('')
  ].join('')
}

function createBoldInsightSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  theme: PptxTheme,
  bullets: string[]
) {
  const statement = slide.takeaway || slide.subtitle || bullets[0] || slide.title
  const evidence = bullets[0] === statement ? bullets.slice(1) : bullets
  const rows = evidence.slice(0, 4).map((bullet, i) => {
    const y = 1580000 + i * 620000
    const tone = theme.tones[(i + 1) % theme.tones.length]
    return [
      createRect(30 + i * 3, `Bold evidence marker ${i + 1}`, 4740000, y + 50000, 180000, 180000, tone.base),
      createTextBox(31 + i * 3, `Bold evidence ${i + 1}`, 5150000, y, 3140000, 330000, [
        { text: bullet, size: 12.5, color: theme.ink, bold: i === 0 }
      ]),
      createRect(32 + i * 3, `Bold evidence rule ${i + 1}`, 5150000, y + 410000, 3000000, 22000, theme.line)
    ].join('')
  })
  return [
    createBaseSlideChrome(slide, index, total, theme),
    createRect(10, 'Bold statement canvas', 520000, 1310000, 3800000, 3000000, theme.tones[1].base),
    createTextBox(11, 'Bold primary statement', 890000, 1740000, 3060000, 1800000, [
      { text: statement, size: 25, color: theme.tones[1].onBase, bold: true }
    ]),
    createTextBox(12, 'Bold statement number', 900000, 3670000, 600000, 400000, [
      { text: String(index + 1).padStart(2, '0'), size: 22, color: theme.tones[1].onBase, bold: true }
    ]),
    rows.join('')
  ].join('')
}

function createOrganicInsightSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  theme: PptxTheme,
  bullets: string[]
) {
  const statement = slide.takeaway || slide.subtitle || bullets[0] || slide.title
  const evidence = bullets[0] === statement ? bullets.slice(1) : bullets
  const rows = evidence.slice(0, 4).map((bullet, i) => {
    const y = 1550000 + i * 650000
    const tone = theme.tones[i % theme.tones.length]
    return [
      createRect(
        30 + i * 3,
        `Organic evidence dot ${i + 1}`,
        4740000,
        y + 40000,
        260000,
        260000,
        tone.base,
        null,
        'ellipse'
      ),
      createTextBox(31 + i * 3, `Organic evidence ${i + 1}`, 5230000, y, 2900000, 370000, [
        { text: bullet, size: 12.5, color: theme.ink, bold: i === 0 }
      ]),
      createRect(32 + i * 3, `Organic evidence rule ${i + 1}`, 5230000, y + 450000, 2800000, 18000, theme.line)
    ].join('')
  })
  return [
    createBaseSlideChrome(slide, index, total, theme),
    createRect(10, 'Organic statement halo', 680000, 1410000, 3500000, 2760000, theme.soft, null, 'ellipse'),
    createRect(12, 'Organic accent orbit', 1040000, 3550000, 520000, 520000, theme.tones[2].base, null, 'ellipse'),
    createTextBox(11, 'Organic primary statement', 1180000, 2030000, 2500000, 1280000, [
      { text: statement, size: 21, color: theme.ink, bold: true }
    ]),
    rows.join('')
  ].join('')
}

function createTechnicalInsightSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  theme: PptxTheme,
  bullets: string[]
) {
  const statement = slide.takeaway || slide.subtitle || bullets[0] || slide.title
  const evidence = bullets[0] === statement ? bullets.slice(1) : bullets
  const rows = evidence.slice(0, 4).map((bullet, i) => {
    const y = 1700000 + i * 570000
    return [
      createRect(
        30 + i * 3,
        `Technical evidence signal ${i + 1}`,
        4670000,
        y + 70000,
        110000,
        110000,
        theme.tones[i % 3].base
      ),
      createTextBox(31 + i * 3, `Technical evidence ${i + 1}`, 5000000, y, 3240000, 300000, [
        { text: bullet, size: 12, color: theme.ink, bold: i === 0 }
      ]),
      createRect(32 + i * 3, `Technical evidence rule ${i + 1}`, 5000000, y + 380000, 3200000, 18000, theme.line)
    ].join('')
  })
  return [
    createBaseSlideChrome(slide, index, total, theme),
    createRect(10, 'Technical insight frame', 720000, 1370000, 3640000, 2860000, theme.card, theme.line),
    createRect(12, 'Technical insight signal', 720000, 1370000, 3640000, 90000, theme.base),
    createTextBox(11, 'Technical primary statement', 1100000, 1900000, 2900000, 1500000, [
      { text: statement, size: 22, color: theme.ink, bold: true }
    ]),
    rows.join('')
  ].join('')
}

function createProcessSlideXml(slide: NormalizedSlide, index: number, total: number, theme: PptxTheme) {
  const steps = (slide.bullets.length ? slide.bullets : ['定义目标', '形成方案', '落地执行', '复盘优化']).slice(0, 5)
  if (shouldUseDenseStepRows(steps, 30)) {
    return createDenseStepRowsSlideXml(slide, index, total, theme, steps, 'process')
  }
  if (['executive', 'consulting', 'formal', 'editorial', 'premium', 'minimal'].includes(theme.language)) {
    return createTypographicSequenceSlideXml(slide, index, total, theme, steps, 'process')
  }
  if (theme.language === 'bold' || theme.language === 'brand') {
    return createColorFieldSequenceSlideXml(slide, index, total, theme, steps, 'process')
  }
  if (theme.language === 'playful' || theme.language === 'organic') {
    return createOrbitalSequenceSlideXml(slide, index, total, theme, steps, 'process')
  }
  if (theme.language === 'product') {
    return createProductSequenceSlideXml(slide, index, total, theme, steps, 'process')
  }
  if (theme.language !== 'data' && theme.language !== 'technical') {
    const stepW = Math.floor(7300000 / steps.length)
    const flow = steps
      .map((step, i) => {
        const x = 790000 + i * stepW
        const tone = theme.tones[i % theme.tones.length]
        return [
          i > 0 ? createRect(60 + i, `Process connector ${i}`, x - 290000, 2520000, 360000, 26000, theme.line) : '',
          createRect(
            70 + i * 4,
            `Process node ${i + 1}`,
            x + 160000,
            2250000,
            520000,
            520000,
            tone.base,
            null,
            'ellipse'
          ),
          createTextBox(71 + i * 4, `Process node number ${i + 1}`, x + 295000, 2390000, 250000, 210000, [
            { text: String(i + 1), size: 15, color: tone.onBase, bold: true }
          ]),
          createRect(72 + i * 4, `Process node rule ${i + 1}`, x + 160000, 2940000, 520000, 32000, tone.base),
          createTextBox(73 + i * 4, `Process node text ${i + 1}`, x - 50000, 3160000, stepW - 100000, 690000, [
            { text: step, size: 12.5, color: theme.ink, bold: true }
          ])
        ].join('')
      })
      .join('')
    return [createBaseSlideChrome(slide, index, total, theme), createTakeawayBand(slide, theme), flow].join('')
  }
  const stepW = Math.floor(7200000 / steps.length)
  const stepXml = steps
    .map((step, i) => {
      const x = 770000 + i * stepW
      return [
        i > 0 ? createRect(60 + i, `Connector ${i}`, x - 210000, 2780000, 320000, 32000, theme.line) : '',
        createRect(
          70 + i * 4,
          `Step circle ${i + 1}`,
          x + 170000,
          2140000,
          520000,
          520000,
          theme.base,
          theme.base,
          'ellipse'
        ),
        createTextBox(71 + i * 4, `Step number ${i + 1}`, x + 284000, 2285000, 300000, 220000, [
          { text: String(i + 1), size: 16, color: theme.onBase, bold: true }
        ]),
        createRect(
          72 + i * 4,
          `Step card ${i + 1}`,
          x,
          2960000,
          stepW - 230000,
          880000,
          theme.card,
          theme.line,
          theme.shape
        ),
        createTextBox(73 + i * 4, `Step text ${i + 1}`, x + 170000, 3170000, stepW - 570000, 420000, [
          { text: step, size: 13, color: theme.ink, bold: true }
        ])
      ].join('')
    })
    .join('')

  return [createBaseSlideChrome(slide, index, total, theme), createTakeawayBand(slide, theme), stepXml].join('')
}

function createTimelineSlideXml(slide: NormalizedSlide, index: number, total: number, theme: PptxTheme) {
  const milestones = (
    slide.bullets.length ? slide.bullets : ['阶段一：定义目标', '阶段二：完成验证', '阶段三：扩大使用']
  ).slice(0, 5)
  if (shouldUseDenseStepRows(milestones, 32)) {
    return createDenseStepRowsSlideXml(slide, index, total, theme, milestones, 'timeline')
  }
  if (['executive', 'consulting', 'formal', 'editorial', 'premium', 'minimal'].includes(theme.language)) {
    return createTypographicSequenceSlideXml(slide, index, total, theme, milestones, 'timeline')
  }
  if (theme.language === 'bold' || theme.language === 'brand') {
    return createColorFieldSequenceSlideXml(slide, index, total, theme, milestones, 'timeline')
  }
  if (theme.language === 'playful' || theme.language === 'organic') {
    return createOrbitalSequenceSlideXml(slide, index, total, theme, milestones, 'timeline')
  }
  if (theme.language === 'product') {
    return createProductSequenceSlideXml(slide, index, total, theme, milestones, 'timeline')
  }
  if (theme.language !== 'data' && theme.language !== 'technical') {
    const span = 7100000
    const startX = 960000
    const timelineY = 2750000
    const gap = milestones.length > 1 ? span / (milestones.length - 1) : span
    const nodes = milestones
      .map((milestone, i) => {
        const x = Math.round(startX + i * gap)
        const isTop = i % 2 === 0
        const tone = theme.tones[i % theme.tones.length]
        const textY = isTop ? 1840000 : 3160000
        return [
          createRect(
            120 + i * 4,
            `Timeline open node ${i + 1}`,
            x - 120000,
            timelineY - 120000,
            240000,
            240000,
            tone.base,
            null,
            'ellipse'
          ),
          createRect(
            121 + i * 4,
            `Timeline open stem ${i + 1}`,
            x - 14000,
            isTop ? textY + 680000 : timelineY + 120000,
            28000,
            470000,
            tone.base
          ),
          createTextBox(122 + i * 4, `Timeline open number ${i + 1}`, x - 640000, textY, 1280000, 260000, [
            { text: String(i + 1).padStart(2, '0'), size: 15, color: tone.base, bold: true }
          ]),
          createTextBox(123 + i * 4, `Timeline open milestone ${i + 1}`, x - 690000, textY + 320000, 1380000, 430000, [
            { text: milestone, size: 11.5, color: theme.ink, bold: true }
          ])
        ].join('')
      })
      .join('')
    return [
      createBaseSlideChrome(slide, index, total, theme),
      createTakeawayBand(slide, theme),
      createRect(40, 'Timeline open line', startX - 140000, timelineY, span + 280000, 30000, theme.line),
      nodes
    ].join('')
  }
  const span = 7100000
  const startX = 960000
  const y = 2680000
  const gap = milestones.length > 1 ? span / (milestones.length - 1) : span
  const milestoneXml = milestones
    .map((milestone, i) => {
      const x = Math.round(startX + i * gap)
      const isTop = i % 2 === 0
      const cardY = isTop ? 1780000 : 3180000
      const markerY = y - 140000
      const cardHeight = 720000
      const stemY = isTop ? cardY + cardHeight : y + 140000
      const stemHeight = isTop ? Math.max(30000, markerY - stemY) : Math.max(30000, cardY - stemY)
      return [
        createRect(
          120 + i * 5,
          `Timeline dot ${i + 1}`,
          x - 140000,
          markerY,
          280000,
          280000,
          theme.base,
          theme.base,
          'ellipse'
        ),
        createRect(121 + i * 5, `Timeline stem ${i + 1}`, x - 15000, stemY, 30000, stemHeight, theme.base),
        createRect(
          122 + i * 5,
          `Timeline card ${i + 1}`,
          x - 760000,
          cardY,
          1520000,
          cardHeight,
          theme.card,
          theme.line,
          theme.shape
        ),
        createTextBox(123 + i * 5, `Timeline number ${i + 1}`, x - 610000, cardY + 120000, 260000, 220000, [
          { text: String(i + 1), size: 13, color: theme.base, bold: true }
        ]),
        createTextBox(124 + i * 5, `Timeline milestone ${i + 1}`, x - 320000, cardY + 115000, 900000, 350000, [
          { text: milestone, size: 12, color: theme.ink, bold: true }
        ])
      ].join('')
    })
    .join('')

  return [
    createBaseSlideChrome(slide, index, total, theme),
    createTakeawayBand(slide, theme),
    createRect(40, 'Timeline line', startX - 160000, y, span + 320000, 42000, theme.line),
    milestoneXml
  ].join('')
}

function createTypographicSequenceSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  theme: PptxTheme,
  items: string[],
  kind: 'process' | 'timeline'
) {
  const isEditorial = theme.language === 'editorial'
  const isExecutive = theme.language === 'executive'
  const isFormal = theme.language === 'formal'
  const isPremium = theme.language === 'premium'
  const isMinimal = theme.language === 'minimal'
  const startY = 1840000
  const gap = 90000
  const rowHeight = Math.min(570000, Math.floor((2580000 - gap * (items.length - 1)) / items.length))
  const markerX = isEditorial ? 720000 : isExecutive ? 760000 : 900000
  const contentX = isEditorial ? 1740000 : isMinimal ? 1440000 : 1600000
  const rows = items
    .map((item, itemIndex) => {
      const parsed = parseStepBullet(item, itemIndex, kind)
      const y = startY + itemIndex * (rowHeight + gap)
      const tone = theme.tones[itemIndex % theme.tones.length]
      const marker = isEditorial
        ? createTextBox(
            100 + itemIndex * 6,
            `Editorial ${kind} folio ${itemIndex + 1}`,
            markerX,
            y - 40000,
            760000,
            rowHeight,
            [{ text: String(itemIndex + 1).padStart(2, '0'), size: 25, color: tone.base, bold: true }]
          )
        : isMinimal || isPremium
          ? createRect(
              100 + itemIndex * 6,
              `${theme.language} ${kind} marker ${itemIndex + 1}`,
              markerX,
              y + Math.floor(rowHeight / 2) - 17000,
              isPremium ? 520000 : 300000,
              isPremium ? 26000 : 34000,
              tone.base
            )
          : createRect(
              100 + itemIndex * 6,
              `${theme.language} ${kind} index field ${itemIndex + 1}`,
              markerX,
              y,
              560000,
              rowHeight,
              isFormal ? theme.card : tone.soft,
              isFormal ? theme.line : null,
              'rect'
            )
      return [
        marker,
        !isEditorial && !isMinimal && !isPremium
          ? createTextBox(
              101 + itemIndex * 6,
              `${theme.language} ${kind} number ${itemIndex + 1}`,
              markerX + 120000,
              y + 90000,
              320000,
              rowHeight - 170000,
              [{ text: String(itemIndex + 1).padStart(2, '0'), size: 15, color: tone.text, bold: true }],
              { anchor: 'ctr' }
            )
          : '',
        createTextBox(
          102 + itemIndex * 6,
          `${theme.language} ${kind} heading ${itemIndex + 1}`,
          contentX,
          y + 50000,
          2050000,
          rowHeight - 100000,
          [{ text: parsed.heading, size: 13.5, color: theme.ink, bold: true }],
          { anchor: 'ctr' }
        ),
        createTextBox(
          103 + itemIndex * 6,
          `${theme.language} ${kind} detail ${itemIndex + 1}`,
          contentX + 2250000,
          y + 50000,
          3550000,
          rowHeight - 100000,
          [{ text: parsed.detail || parsed.period, size: 11.5, color: theme.muted }],
          { anchor: 'ctr' }
        ),
        createRect(
          104 + itemIndex * 6,
          `${theme.language} ${kind} rule ${itemIndex + 1}`,
          contentX,
          y + rowHeight,
          5800000,
          isExecutive ? 36000 : 22000,
          itemIndex === 0 && isExecutive ? theme.base : theme.line
        )
      ].join('')
    })
    .join('')
  return [
    createBaseSlideChrome(slide, index, total, theme),
    createTakeawayBand(slide, theme),
    createRect(
      80,
      `${theme.language} ${kind} signature rail`,
      isEditorial ? 640000 : 760000,
      startY - 80000,
      isEditorial ? 36000 : 22000,
      2590000,
      theme.base
    ),
    rows
  ].join('')
}

function createColorFieldSequenceSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  theme: PptxTheme,
  items: string[],
  kind: 'process' | 'timeline'
) {
  const gap = 65000
  const width = Math.floor((7900000 - gap * (items.length - 1)) / items.length)
  const fields = items
    .map((item, itemIndex) => {
      const parsed = parseStepBullet(item, itemIndex, kind)
      const x = 620000 + itemIndex * (width + gap)
      const tone = theme.tones[itemIndex % theme.tones.length]
      const y = itemIndex % 2 === 0 ? 1910000 : 2180000
      const height = itemIndex % 2 === 0 ? 2140000 : 1870000
      return [
        createRect(
          100 + itemIndex * 5,
          `${theme.language} ${kind} color field ${itemIndex + 1}`,
          x,
          y,
          width,
          height,
          tone.base
        ),
        createTextBox(
          101 + itemIndex * 5,
          `${theme.language} ${kind} field number ${itemIndex + 1}`,
          x + 180000,
          y + 180000,
          width - 360000,
          330000,
          [{ text: String(itemIndex + 1).padStart(2, '0'), size: 19, color: tone.onBase, bold: true }]
        ),
        createTextBox(
          102 + itemIndex * 5,
          `${theme.language} ${kind} field heading ${itemIndex + 1}`,
          x + 180000,
          y + 720000,
          width - 360000,
          520000,
          [{ text: parsed.heading, size: 14, color: tone.onBase, bold: true }]
        ),
        createTextBox(
          103 + itemIndex * 5,
          `${theme.language} ${kind} field detail ${itemIndex + 1}`,
          x + 180000,
          y + 1370000,
          width - 360000,
          height - 1550000,
          [{ text: parsed.detail || parsed.period, size: 10.5, color: tone.onBase }]
        )
      ].join('')
    })
    .join('')
  return [createBaseSlideChrome(slide, index, total, theme), createTakeawayBand(slide, theme), fields].join('')
}

function createOrbitalSequenceSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  theme: PptxTheme,
  items: string[],
  kind: 'process' | 'timeline'
) {
  const span = 6900000
  const startX = 1120000
  const gap = items.length > 1 ? span / (items.length - 1) : span
  const baseY = 2780000
  const nodes = items
    .map((item, itemIndex) => {
      const parsed = parseStepBullet(item, itemIndex, kind)
      const x = Math.round(startX + itemIndex * gap)
      const y = baseY + (itemIndex % 2 === 0 ? -250000 : 250000)
      const size = theme.language === 'playful' ? 600000 : 520000
      const tone = theme.tones[itemIndex % theme.tones.length]
      return [
        createRect(
          100 + itemIndex * 5,
          `${theme.language} ${kind} orbit ${itemIndex + 1}`,
          x - size / 2,
          y - size / 2,
          size,
          size,
          tone.base,
          null,
          'ellipse'
        ),
        createTextBox(
          101 + itemIndex * 5,
          `${theme.language} ${kind} orbit number ${itemIndex + 1}`,
          x - 170000,
          y - 115000,
          340000,
          230000,
          [{ text: String(itemIndex + 1), size: 16, color: tone.onBase, bold: true }],
          { anchor: 'ctr' }
        ),
        createTextBox(
          102 + itemIndex * 5,
          `${theme.language} ${kind} orbit heading ${itemIndex + 1}`,
          x - 680000,
          itemIndex % 2 === 0 ? y - 830000 : y + 450000,
          1360000,
          330000,
          [{ text: parsed.heading, size: 12.5, color: theme.ink, bold: true }]
        ),
        createTextBox(
          103 + itemIndex * 5,
          `${theme.language} ${kind} orbit detail ${itemIndex + 1}`,
          x - 680000,
          itemIndex % 2 === 0 ? y - 500000 : y + 770000,
          1360000,
          300000,
          [{ text: parsed.detail || parsed.period, size: 10.5, color: theme.muted }]
        )
      ].join('')
    })
    .join('')
  return [
    createBaseSlideChrome(slide, index, total, theme),
    createTakeawayBand(slide, theme),
    createRect(
      80,
      `${theme.language} ${kind} curved path`,
      startX - 300000,
      baseY - 18000,
      span + 600000,
      36000,
      theme.line
    ),
    nodes
  ].join('')
}

function createProductSequenceSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  theme: PptxTheme,
  items: string[],
  kind: 'process' | 'timeline'
) {
  const rowHeight = Math.min(590000, Math.floor(2580000 / items.length))
  const rows = items
    .map((item, itemIndex) => {
      const parsed = parseStepBullet(item, itemIndex, kind)
      const y = 1830000 + itemIndex * (rowHeight + 70000)
      const tone = theme.tones[itemIndex % theme.tones.length]
      return [
        createRect(
          100 + itemIndex * 5,
          `Product ${kind} focus ${itemIndex + 1}`,
          850000,
          y,
          860000,
          rowHeight,
          tone.soft,
          null,
          'roundRect'
        ),
        createTextBox(
          101 + itemIndex * 5,
          `Product ${kind} number ${itemIndex + 1}`,
          1080000,
          y + 80000,
          400000,
          rowHeight - 160000,
          [{ text: String(itemIndex + 1).padStart(2, '0'), size: 18, color: tone.text, bold: true }],
          { anchor: 'ctr' }
        ),
        createTextBox(
          102 + itemIndex * 5,
          `Product ${kind} heading ${itemIndex + 1}`,
          2010000,
          y + 70000,
          2300000,
          rowHeight - 140000,
          [{ text: parsed.heading, size: 13.5, color: theme.ink, bold: true }],
          { anchor: 'ctr' }
        ),
        createTextBox(
          103 + itemIndex * 5,
          `Product ${kind} detail ${itemIndex + 1}`,
          4560000,
          y + 70000,
          3440000,
          rowHeight - 140000,
          [{ text: parsed.detail || parsed.period, size: 11, color: theme.muted }],
          { anchor: 'ctr' }
        ),
        createRect(
          104 + itemIndex * 5,
          `Product ${kind} completion rail ${itemIndex + 1}`,
          8200000,
          y,
          70000,
          rowHeight,
          tone.base
        )
      ].join('')
    })
    .join('')
  return [createBaseSlideChrome(slide, index, total, theme), createTakeawayBand(slide, theme), rows].join('')
}

function createDenseStepRowsSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  theme: PptxTheme,
  items: string[],
  kind: 'process' | 'timeline'
) {
  const gap = 80000
  const availableHeight = 2540000
  const rowHeight = Math.min(560000, Math.floor((availableHeight - gap * Math.max(0, items.length - 1)) / items.length))
  const startY = 1820000
  const trackX = 1120000
  const firstCenterY = startY + Math.floor(rowHeight / 2)
  const lastCenterY = startY + (items.length - 1) * (rowHeight + gap) + Math.floor(rowHeight / 2)
  const rowsXml = items
    .map((item, i) => {
      const parsed = parseStepBullet(item, i, kind)
      const y = startY + i * (rowHeight + gap)
      const centerY = y + Math.floor(rowHeight / 2)
      return [
        createRect(
          100 + i * 6,
          `${kind} marker ${i + 1}`,
          trackX - 95000,
          centerY - 95000,
          190000,
          190000,
          theme.base,
          theme.base,
          'ellipse'
        ),
        createRect(
          101 + i * 6,
          `${kind} detail row ${i + 1}`,
          1460000,
          y,
          6860000,
          rowHeight,
          theme.card,
          theme.line,
          theme.shape
        ),
        createTextBox(
          102 + i * 6,
          `${kind} period ${i + 1}`,
          1680000,
          y + 60000,
          1080000,
          rowHeight - 120000,
          [{ text: parsed.period, size: 12, color: theme.base, bold: true }],
          { anchor: 'ctr' }
        ),
        createTextBox(
          103 + i * 6,
          `${kind} heading ${i + 1}`,
          2870000,
          y + 60000,
          1540000,
          rowHeight - 120000,
          [{ text: parsed.heading, size: 12.5, color: theme.ink, bold: true }],
          { anchor: 'ctr' }
        ),
        parsed.detail
          ? createTextBox(
              104 + i * 6,
              `${kind} detail ${i + 1}`,
              4530000,
              y + 60000,
              3440000,
              rowHeight - 120000,
              [{ text: parsed.detail, size: 10.5, color: theme.muted }],
              { anchor: 'ctr' }
            )
          : ''
      ].join('')
    })
    .join('')

  return [
    createBaseSlideChrome(slide, index, total, theme),
    createTakeawayBand(slide, theme),
    items.length > 1
      ? createRect(
          90,
          `${kind} track`,
          trackX - 18000,
          firstCenterY,
          36000,
          Math.max(36000, lastCenterY - firstCenterY),
          theme.line
        )
      : '',
    rowsXml
  ].join('')
}

function createNetworkSlideXml(slide: NormalizedSlide, index: number, total: number, theme: PptxTheme) {
  const items = (
    slide.bullets.length
      ? slide.bullets
      : ['用户 | 需求与反馈', '产品 | 体验与交付', '内容 | 专业知识', '伙伴 | 场景协同']
  )
    .slice(0, 6)
    .map(parseCardBullet)
  const positions = [
    { x: 650000, y: 1450000 },
    { x: 3450000, y: 1450000 },
    { x: 6250000, y: 1450000 },
    { x: 6250000, y: 3650000 },
    { x: 3450000, y: 3650000 },
    { x: 650000, y: 3650000 }
  ]
  const links = [
    createRect(20, 'Network link top', 1775000, 2190000, 5600000, 26000, theme.line),
    createRect(21, 'Network link bottom', 1775000, 3470000, 5600000, 26000, theme.line),
    createRect(22, 'Network link hub top', 4560000, 2190000, 26000, 310000, theme.line),
    createRect(23, 'Network link hub bottom', 4560000, 3190000, 26000, 306000, theme.line),
    ...positions.map((position, positionIndex) =>
      createRect(
        24 + positionIndex,
        `Network spoke ${positionIndex + 1}`,
        position.x + 1110000,
        positionIndex < 3 ? 2170000 : 3470000,
        26000,
        200000,
        theme.line
      )
    )
  ].join('')
  const nodes = items
    .map((item, itemIndex) => {
      const position = positions[itemIndex]
      const tone = theme.tones[itemIndex % theme.tones.length]
      const kinetic = theme.composition === 'kinetic'
      const spatial = theme.composition === 'spatial'
      const fill = kinetic ? tone.base : spatial ? theme.bg : theme.card
      const line = spatial ? tone.base : kinetic ? tone.base : theme.line
      const color = kinetic ? tone.onBase : theme.ink
      return [
        createRect(
          50 + itemIndex * 3,
          `Network node ${itemIndex + 1}`,
          position.x,
          position.y,
          2250000,
          820000,
          fill,
          line,
          spatial ? 'roundRect' : theme.shape
        ),
        createTextBox(
          51 + itemIndex * 3,
          `Network node label ${itemIndex + 1}`,
          position.x + 190000,
          position.y + 135000,
          1870000,
          250000,
          [{ text: item.heading, size: 12.5, color, bold: true }]
        ),
        item.detail
          ? createTextBox(
              52 + itemIndex * 3,
              `Network node detail ${itemIndex + 1}`,
              position.x + 190000,
              position.y + 430000,
              1870000,
              220000,
              [{ text: item.detail, size: 10.5, color: kinetic ? tone.onBase : theme.muted }]
            )
          : ''
      ].join('')
    })
    .join('')
  const hubText = slide.takeaway || slide.subtitle || slide.title
  return [
    createBaseSlideChrome(slide, index, total, theme),
    links,
    createRect(40, 'Network hub', 3450000, 2460000, 2250000, 730000, theme.deep, theme.deep, theme.shape),
    createTextBox(
      41,
      'Network hub statement',
      3700000,
      2650000,
      1750000,
      300000,
      [{ text: hubText, size: 14, color: pptxContrastText(theme.deep), bold: true }],
      { anchor: 'ctr' }
    ),
    nodes
  ].join('')
}

function createMatrixSlideXml(slide: NormalizedSlide, index: number, total: number, theme: PptxTheme) {
  const items = (
    slide.bullets.length
      ? slide.bullets
      : ['高影响 | 优先推进', '高潜力 | 小步验证', '稳定基础 | 持续运营', '低收益 | 谨慎投入']
  )
    .slice(0, 4)
    .map(parseCardBullet)
  const positions = [
    { x: 760000, y: 1780000 },
    { x: 4740000, y: 1780000 },
    { x: 760000, y: 3240000 },
    { x: 4740000, y: 3240000 }
  ]
  const quadrants = items
    .map((item, itemIndex) => {
      const position = positions[itemIndex]
      const tone = theme.tones[itemIndex % theme.tones.length]
      const kinetic = theme.composition === 'kinetic'
      const fill = kinetic ? tone.base : theme.composition === 'spatial' ? theme.bg : tone.soft
      const line = kinetic ? tone.base : theme.composition === 'spatial' ? tone.base : theme.line
      const color = kinetic ? tone.onBase : theme.ink
      return [
        createRect(
          30 + itemIndex * 4,
          `Matrix quadrant ${itemIndex + 1}`,
          position.x,
          position.y,
          3650000,
          1190000,
          fill,
          line,
          theme.shape
        ),
        createTextBox(
          31 + itemIndex * 4,
          `Matrix quadrant index ${itemIndex + 1}`,
          position.x + 210000,
          position.y + 160000,
          480000,
          260000,
          [
            {
              text: String(itemIndex + 1).padStart(2, '0'),
              size: 13,
              color: kinetic ? tone.onBase : tone.base,
              bold: true
            }
          ]
        ),
        createTextBox(
          32 + itemIndex * 4,
          `Matrix quadrant label ${itemIndex + 1}`,
          position.x + 820000,
          position.y + 150000,
          2500000,
          300000,
          [{ text: item.heading, size: 14, color, bold: true }]
        ),
        item.detail
          ? createTextBox(
              33 + itemIndex * 4,
              `Matrix quadrant detail ${itemIndex + 1}`,
              position.x + 820000,
              position.y + 570000,
              2500000,
              360000,
              [{ text: item.detail, size: 11, color: kinetic ? tone.onBase : theme.muted }]
            )
          : ''
      ].join('')
    })
    .join('')
  return [
    createBaseSlideChrome(slide, index, total, theme),
    slide.takeaway || slide.subtitle
      ? createTextBox(10, 'Matrix premise', 760000, 1190000, 7600000, 340000, [
          { text: slide.takeaway || slide.subtitle || '', size: 14, color: theme.ink, bold: true }
        ])
      : '',
    createRect(20, 'Matrix axis vertical', 4500000, 1670000, 26000, 2870000, theme.base),
    createRect(21, 'Matrix axis horizontal', 650000, 3090000, 7920000, 26000, theme.base),
    quadrants
  ].join('')
}

function createScheduleSlideXml(slide: NormalizedSlide, index: number, total: number, theme: PptxTheme) {
  const items = (
    slide.bullets.length
      ? slide.bullets
      : ['09:00 | 开场：确认共同目标', '10:00 | 主题分享：建立核心认知', '11:00 | 共创讨论：形成行动方案']
  )
    .slice(0, 6)
    .map((item, itemIndex) => parseStepBullet(item, itemIndex, 'timeline'))
  const rows = items
    .map((item, itemIndex) => {
      const y = 1500000 + itemIndex * 560000
      const tone = theme.tones[itemIndex % theme.tones.length]
      const kinetic = theme.composition === 'kinetic'
      return [
        createRect(
          30 + itemIndex * 4,
          `Schedule time field ${itemIndex + 1}`,
          760000,
          y,
          1300000,
          430000,
          kinetic ? tone.base : tone.soft,
          kinetic ? tone.base : theme.line,
          theme.shape
        ),
        createTextBox(
          31 + itemIndex * 4,
          `Schedule time ${itemIndex + 1}`,
          920000,
          y + 95000,
          980000,
          220000,
          [{ text: item.period, size: 12.5, color: kinetic ? tone.onBase : tone.text, bold: true }],
          { anchor: 'ctr' }
        ),
        createRect(
          32 + itemIndex * 4,
          `Schedule event rule ${itemIndex + 1}`,
          2260000,
          y + 205000,
          260000,
          26000,
          tone.base
        ),
        createTextBox(33 + itemIndex * 4, `Schedule event ${itemIndex + 1}`, 2700000, y + 65000, 5480000, 300000, [
          {
            text: item.detail ? `${item.heading}：${item.detail}` : item.heading,
            size: 12.5,
            color: theme.ink,
            bold: itemIndex === 0
          }
        ])
      ].join('')
    })
    .join('')
  return [
    createBaseSlideChrome(slide, index, total, theme),
    slide.takeaway || slide.subtitle
      ? createTextBox(10, 'Schedule premise', 760000, 1100000, 7600000, 260000, [
          { text: slide.takeaway || slide.subtitle || '', size: 13.5, color: theme.muted, bold: true }
        ])
      : '',
    createRect(
      20,
      'Schedule running line',
      2360000,
      1500000,
      26000,
      Math.max(430000, (items.length - 1) * 560000 + 430000),
      theme.line
    ),
    rows
  ].join('')
}

function createRouteSlideXml(slide: NormalizedSlide, index: number, total: number, theme: PptxTheme) {
  const items = (
    slide.bullets.length
      ? slide.bullets
      : ['起点 | 明确问题：建立共同目标', '探索 | 收集证据：理解真实需求', '抵达 | 形成方案：进入下一阶段']
  )
    .slice(0, 6)
    .map((item, itemIndex) => parseStepBullet(item, itemIndex, 'timeline'))
  const positions = [
    { x: 650000, y: 1550000 },
    { x: 3300000, y: 1550000 },
    { x: 5950000, y: 1550000 },
    { x: 5950000, y: 3540000 },
    { x: 3300000, y: 3540000 },
    { x: 650000, y: 3540000 }
  ]
  const path = [
    createRect(20, 'Route path outbound', 1680000, 1950000, 5320000, 42000, theme.line),
    createRect(21, 'Route path turn', 6970000, 1950000, 42000, 1990000, theme.line),
    createRect(22, 'Route path return', 1680000, 3900000, 5320000, 42000, theme.line)
  ].join('')
  const stops = items
    .map((item, itemIndex) => {
      const position = positions[itemIndex]
      const tone = theme.tones[itemIndex % theme.tones.length]
      const kinetic = theme.composition === 'kinetic'
      const fill = kinetic ? tone.base : theme.composition === 'spatial' ? theme.bg : theme.card
      const line = kinetic ? tone.base : tone.base
      const color = kinetic ? tone.onBase : theme.ink
      return [
        createRect(
          30 + itemIndex * 4,
          `Route stop ${itemIndex + 1}`,
          position.x,
          position.y,
          2100000,
          820000,
          fill,
          line,
          theme.shape
        ),
        createTextBox(
          31 + itemIndex * 4,
          `Route stop number ${itemIndex + 1}`,
          position.x + 150000,
          position.y + 115000,
          360000,
          240000,
          [
            {
              text: String(itemIndex + 1).padStart(2, '0'),
              size: 12,
              color: kinetic ? tone.onBase : tone.base,
              bold: true
            }
          ]
        ),
        createTextBox(
          32 + itemIndex * 4,
          `Route stop label ${itemIndex + 1}`,
          position.x + 600000,
          position.y + 105000,
          1310000,
          260000,
          [{ text: item.heading, size: 12.5, color, bold: true }]
        ),
        item.detail
          ? createTextBox(
              33 + itemIndex * 4,
              `Route stop detail ${itemIndex + 1}`,
              position.x + 600000,
              position.y + 430000,
              1310000,
              220000,
              [{ text: item.detail, size: 10.5, color: kinetic ? tone.onBase : theme.muted }]
            )
          : ''
      ].join('')
    })
    .join('')
  return [
    createBaseSlideChrome(slide, index, total, theme),
    slide.takeaway || slide.subtitle
      ? createTextBox(10, 'Route premise', 760000, 1110000, 7600000, 260000, [
          { text: slide.takeaway || slide.subtitle || '', size: 13.5, color: theme.muted, bold: true }
        ])
      : '',
    path,
    stops
  ].join('')
}

function createComparisonSlideXml(slide: NormalizedSlide, index: number, total: number, theme: PptxTheme) {
  const bullets = slide.bullets.length ? slide.bullets : ['现状：信息分散，决策链路长', '目标：结构清晰，行动路径明确']
  const midpoint = Math.ceil(bullets.length / 2)
  const left = bullets.slice(0, midpoint)
  const right = bullets.slice(midpoint)
  if (
    ['classic', 'executive', 'consulting', 'formal', 'product', 'editorial', 'premium', 'minimal'].includes(
      theme.language
    )
  ) {
    return [
      createBaseSlideChrome(slide, index, total, theme),
      createTextBox(20, 'Comparison left heading', 830000, 1500000, 3000000, 380000, [
        { text: '当前状态', size: 17, color: theme.base, bold: true }
      ]),
      createRect(21, 'Comparison left rule', 830000, 1970000, 900000, 36000, theme.base),
      createTextBox(
        22,
        'Comparison left evidence',
        830000,
        2240000,
        3200000,
        1640000,
        left.slice(0, 5).map((bullet) => ({ text: bullet, size: 12.5, color: theme.ink }))
      ),
      createRect(23, 'Comparison center rule', 4520000, 1460000, 26000, 2550000, theme.line),
      createTextBox(24, 'Comparison right heading', 5010000, 1500000, 3000000, 380000, [
        { text: '优化方向', size: 17, color: theme.tones[1].base, bold: true }
      ]),
      createRect(25, 'Comparison right rule', 5010000, 1970000, 900000, 36000, theme.tones[1].base),
      createTextBox(
        26,
        'Comparison right evidence',
        5010000,
        2240000,
        3200000,
        1640000,
        (right.length ? right : left).slice(0, 5).map((bullet) => ({ text: bullet, size: 12.5, color: theme.ink }))
      )
    ].join('')
  }
  if (theme.language === 'bold' || theme.language === 'brand') {
    const leftTone = theme.tones[0]
    const rightTone = theme.tones[1]
    return [
      createBaseSlideChrome(slide, index, total, theme),
      createRect(20, 'Comparison left color field', 520000, 1380000, 4050000, 2860000, leftTone.base),
      createTextBox(21, 'Comparison left heading', 870000, 1750000, 3200000, 380000, [
        { text: '当前状态', size: 17, color: leftTone.onBase, bold: true }
      ]),
      createTextBox(
        22,
        'Comparison left evidence',
        870000,
        2370000,
        3200000,
        1420000,
        left.slice(0, 5).map((bullet) => ({ text: bullet, size: 12.5, color: leftTone.onBase }))
      ),
      createRect(23, 'Comparison right color field', 4570000, 1380000, 4050000, 2860000, rightTone.base),
      createTextBox(24, 'Comparison right heading', 4920000, 1750000, 3200000, 380000, [
        { text: '优化方向', size: 17, color: rightTone.onBase, bold: true }
      ]),
      createTextBox(
        25,
        'Comparison right evidence',
        4920000,
        2370000,
        3200000,
        1420000,
        (right.length ? right : left)
          .slice(0, 5)
          .map((bullet) => ({ text: bullet, size: 12.5, color: rightTone.onBase }))
      )
    ].join('')
  }
  if (theme.language === 'playful' || theme.language === 'organic') {
    return [
      createBaseSlideChrome(slide, index, total, theme),
      createRect(
        20,
        'Comparison left soft field',
        650000,
        1480000,
        3700000,
        2680000,
        theme.tones[0].soft,
        null,
        'roundRect'
      ),
      createRect(21, 'Comparison left bubble', 960000, 1740000, 520000, 520000, theme.tones[0].base, null, 'ellipse'),
      createTextBox(22, 'Comparison left heading', 1630000, 1800000, 2300000, 350000, [
        { text: '当前状态', size: 16, color: theme.ink, bold: true }
      ]),
      createTextBox(
        23,
        'Comparison left evidence',
        980000,
        2490000,
        3050000,
        1320000,
        left.slice(0, 5).map((bullet) => ({ text: bullet, size: 12, color: theme.ink }))
      ),
      createRect(
        24,
        'Comparison right soft field',
        4810000,
        1480000,
        3700000,
        2680000,
        theme.tones[1].soft,
        null,
        'roundRect'
      ),
      createRect(25, 'Comparison right bubble', 5120000, 1740000, 520000, 520000, theme.tones[1].base, null, 'ellipse'),
      createTextBox(26, 'Comparison right heading', 5790000, 1800000, 2300000, 350000, [
        { text: '优化方向', size: 16, color: theme.ink, bold: true }
      ]),
      createTextBox(
        27,
        'Comparison right evidence',
        5140000,
        2490000,
        3050000,
        1320000,
        (right.length ? right : left).slice(0, 5).map((bullet) => ({ text: bullet, size: 12, color: theme.ink }))
      )
    ].join('')
  }
  return [
    createBaseSlideChrome(slide, index, total, theme),
    createColumnBlock(
      20,
      'Current',
      760000,
      1510000,
      3600000,
      2460000,
      '当前状态',
      left,
      theme.card,
      theme.ink,
      theme.line,
      theme.shape
    ),
    createColumnBlock(
      50,
      'Target',
      4780000,
      1510000,
      3600000,
      2460000,
      '优化方向',
      right.length ? right : left,
      theme.soft,
      theme.text,
      theme.line,
      theme.shape
    )
  ].join('')
}

function createChartSlideXml(slide: NormalizedSlide, index: number, total: number, theme: PptxTheme) {
  const data = (slide.bullets.length ? slide.bullets : ['完成率：72%', '复用率：48%', '满意度：86%'])
    .slice(0, 6)
    .map(parseChartBullet)
  const maxValue = Math.max(...data.map((item) => item.numeric), 1)
  if (['consulting', 'editorial', 'premium', 'minimal'].includes(theme.language)) {
    return createTypographicChartSlideXml(slide, index, total, theme, data, maxValue)
  }
  if (theme.language === 'executive' || theme.language === 'formal') {
    return createExecutiveChartSlideXml(slide, index, total, theme, data, maxValue)
  }
  if (theme.language === 'technical' || theme.language === 'data') {
    return createInstrumentChartSlideXml(slide, index, total, theme, data, maxValue)
  }
  if (theme.language === 'product') {
    return createProductChartSlideXml(slide, index, total, theme, data, maxValue)
  }
  if (theme.language === 'bold' || theme.language === 'brand') {
    return createColorFieldChartSlideXml(slide, index, total, theme, data, maxValue)
  }
  if (theme.language === 'playful' || theme.language === 'organic') {
    return createBubbleChartSlideXml(slide, index, total, theme, data, maxValue)
  }
  const chartXml = data
    .map((item, i) => {
      const y = 1840000 + i * 420000
      const barW = Math.max(180000, Math.round((item.numeric / maxValue) * 4380000))
      const tone = theme.tones[i % theme.tones.length]
      return [
        createTextBox(80 + i * 5, `Chart label ${i + 1}`, 900000, y - 15000, 1480000, 260000, [
          { text: item.label, size: 12, color: theme.ink, bold: true }
        ]),
        createRect(
          81 + i * 5,
          `Chart track ${i + 1}`,
          2520000,
          y + 40000,
          4580000,
          180000,
          theme.line,
          theme.line,
          theme.shape
        ),
        createRect(
          82 + i * 5,
          `Chart bar ${i + 1}`,
          2520000,
          y + 40000,
          barW,
          180000,
          tone.base,
          tone.base,
          theme.shape
        ),
        createTextBox(83 + i * 5, `Chart value ${i + 1}`, 7280000, y - 15000, 850000, 260000, [
          { text: item.value, size: 13, color: tone.text, bold: true }
        ])
      ].join('')
    })
    .join('')

  return [
    createBaseSlideChrome(slide, index, total, theme),
    createTakeawayBand(slide, theme),
    ['classic', 'executive', 'consulting', 'formal', 'product', 'editorial', 'premium', 'minimal'].includes(
      theme.language
    )
      ? ''
      : createRect(60, 'Chart panel', 720000, 1800000, 7700000, 2580000, theme.card, theme.line, theme.shape),
    chartXml
  ].join('')
}

type PptxChartDatum = ReturnType<typeof parseChartBullet>

function createTypographicChartSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  theme: PptxTheme,
  data: PptxChartDatum[],
  maxValue: number
) {
  const isEditorial = theme.language === 'editorial'
  const isPremium = theme.language === 'premium'
  const isMinimal = theme.language === 'minimal'
  const rows = data
    .map((item, itemIndex) => {
      const y = 1820000 + itemIndex * 430000
      const ratio = chartValueRatio(item.numeric, maxValue)
      const tone = theme.tones[itemIndex % theme.tones.length]
      const markerX = Math.round(3440000 + ratio * 4100000)
      return [
        createTextBox(
          80 + itemIndex * 6,
          `${theme.language} chart rank ${itemIndex + 1}`,
          760000,
          y - 30000,
          560000,
          300000,
          [
            {
              text: String(itemIndex + 1).padStart(2, '0'),
              size: isEditorial ? 19 : 13,
              color: isEditorial ? tone.base : theme.muted,
              bold: true
            }
          ]
        ),
        createTextBox(
          81 + itemIndex * 6,
          `${theme.language} chart label ${itemIndex + 1}`,
          1460000,
          y - 25000,
          1650000,
          300000,
          [{ text: item.label, size: 12.5, color: theme.ink, bold: itemIndex === 0 }]
        ),
        createRect(
          82 + itemIndex * 6,
          `${theme.language} chart rule ${itemIndex + 1}`,
          3440000,
          y + 120000,
          4100000,
          isPremium ? 22000 : 30000,
          theme.line
        ),
        createRect(
          83 + itemIndex * 6,
          `${theme.language} chart marker ${itemIndex + 1}`,
          markerX - (isMinimal ? 65000 : 85000),
          y + 50000,
          isMinimal ? 130000 : 170000,
          isMinimal ? 130000 : 170000,
          tone.base,
          null,
          'ellipse'
        ),
        createTextBox(
          84 + itemIndex * 6,
          `${theme.language} chart value ${itemIndex + 1}`,
          7750000,
          y - 25000,
          700000,
          300000,
          [{ text: item.value, size: 13, color: tone.text, bold: true }]
        )
      ].join('')
    })
    .join('')
  return [createBaseSlideChrome(slide, index, total, theme), createTakeawayBand(slide, theme), rows].join('')
}

function createExecutiveChartSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  theme: PptxTheme,
  data: PptxChartDatum[],
  maxValue: number
) {
  const rows = data
    .map((item, itemIndex) => {
      const y = 1810000 + itemIndex * 430000
      const ratio = chartValueRatio(item.numeric, maxValue)
      const tone = theme.tones[itemIndex % theme.tones.length]
      return [
        createRect(
          80 + itemIndex * 7,
          `${theme.language} chart row ${itemIndex + 1}`,
          760000,
          y,
          7600000,
          340000,
          theme.card,
          theme.line
        ),
        createRect(
          81 + itemIndex * 7,
          `${theme.language} chart row index ${itemIndex + 1}`,
          760000,
          y,
          520000,
          340000,
          itemIndex === 0 ? theme.base : theme.soft
        ),
        createTextBox(
          82 + itemIndex * 7,
          `${theme.language} chart row number ${itemIndex + 1}`,
          880000,
          y + 60000,
          280000,
          220000,
          [{ text: String(itemIndex + 1), size: 13, color: itemIndex === 0 ? theme.onBase : theme.text, bold: true }]
        ),
        createTextBox(
          83 + itemIndex * 7,
          `${theme.language} chart row label ${itemIndex + 1}`,
          1480000,
          y + 45000,
          1740000,
          240000,
          [{ text: item.label, size: 12, color: theme.ink, bold: true }]
        ),
        createRect(
          84 + itemIndex * 7,
          `${theme.language} chart row track ${itemIndex + 1}`,
          3440000,
          y + 130000,
          3500000,
          70000,
          theme.line
        ),
        createRect(
          85 + itemIndex * 7,
          `${theme.language} chart row bar ${itemIndex + 1}`,
          3440000,
          y + 130000,
          Math.max(90000, Math.round(3500000 * ratio)),
          70000,
          tone.base
        ),
        createTextBox(
          86 + itemIndex * 7,
          `${theme.language} chart row value ${itemIndex + 1}`,
          7280000,
          y + 45000,
          780000,
          240000,
          [{ text: item.value, size: 13, color: tone.text, bold: true }]
        )
      ].join('')
    })
    .join('')
  return [createBaseSlideChrome(slide, index, total, theme), createTakeawayBand(slide, theme), rows].join('')
}

function createInstrumentChartSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  theme: PptxTheme,
  data: PptxChartDatum[],
  maxValue: number
) {
  const grid = [0, 1, 2, 3, 4]
    .map((gridIndex) =>
      createRect(
        60 + gridIndex,
        `Instrument grid ${gridIndex + 1}`,
        2780000 + gridIndex * 1100000,
        1800000,
        22000,
        2520000,
        theme.line
      )
    )
    .join('')
  const rows = data
    .map((item, itemIndex) => {
      const y = 1830000 + itemIndex * 410000
      const ratio = chartValueRatio(item.numeric, maxValue)
      const tone = theme.tones[itemIndex % theme.tones.length]
      return [
        createTextBox(90 + itemIndex * 5, `Instrument label ${itemIndex + 1}`, 850000, y, 1600000, 260000, [
          { text: item.label, size: 11.5, color: theme.ink, bold: true }
        ]),
        createRect(
          91 + itemIndex * 5,
          `Instrument signal ${itemIndex + 1}`,
          2780000,
          y + 70000,
          Math.max(120000, Math.round(4400000 * ratio)),
          130000,
          tone.base
        ),
        createRect(
          92 + itemIndex * 5,
          `Instrument cap ${itemIndex + 1}`,
          Math.round(2780000 + 4400000 * ratio),
          y + 35000,
          36000,
          200000,
          tone.onBase
        ),
        createTextBox(93 + itemIndex * 5, `Instrument value ${itemIndex + 1}`, 7480000, y, 720000, 260000, [
          { text: item.value, size: 12.5, color: tone.text, bold: true }
        ])
      ].join('')
    })
    .join('')
  return [
    createBaseSlideChrome(slide, index, total, theme),
    createTakeawayBand(slide, theme),
    createRect(50, 'Instrument chart frame', 720000, 1730000, 7700000, 2760000, theme.card, theme.line),
    createRect(51, 'Instrument chart status', 720000, 1730000, 1320000, 65000, theme.base),
    grid,
    rows
  ].join('')
}

function createProductChartSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  theme: PptxTheme,
  data: PptxChartDatum[],
  maxValue: number
) {
  const rows = data
    .map((item, itemIndex) => {
      const y = 1870000 + itemIndex * 410000
      const ratio = chartValueRatio(item.numeric, maxValue)
      const tone = theme.tones[itemIndex % theme.tones.length]
      const markerX = Math.round(3000000 + ratio * 3900000)
      return [
        createTextBox(70 + itemIndex * 5, `Product chart label ${itemIndex + 1}`, 900000, y - 25000, 1800000, 280000, [
          { text: item.label, size: 12.5, color: theme.ink, bold: true }
        ]),
        createRect(
          71 + itemIndex * 5,
          `Product chart track ${itemIndex + 1}`,
          3000000,
          y + 105000,
          3900000,
          26000,
          theme.line
        ),
        createRect(
          72 + itemIndex * 5,
          `Product chart focus ${itemIndex + 1}`,
          markerX - 105000,
          y + 13000,
          210000,
          210000,
          tone.base,
          null,
          'ellipse'
        ),
        createTextBox(73 + itemIndex * 5, `Product chart value ${itemIndex + 1}`, 7270000, y - 25000, 900000, 280000, [
          { text: item.value, size: 13, color: tone.text, bold: true }
        ])
      ].join('')
    })
    .join('')
  return [createBaseSlideChrome(slide, index, total, theme), createTakeawayBand(slide, theme), rows].join('')
}

function createColorFieldChartSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  theme: PptxTheme,
  data: PptxChartDatum[],
  maxValue: number
) {
  const rows = data
    .map((item, itemIndex) => {
      const y = 1770000 + itemIndex * 440000
      const ratio = chartValueRatio(item.numeric, maxValue)
      const tone = theme.tones[itemIndex % theme.tones.length]
      const fieldWidth = Math.max(1600000, Math.round(6900000 * ratio))
      return [
        createRect(
          70 + itemIndex * 4,
          `${theme.language} chart field ${itemIndex + 1}`,
          760000,
          y,
          fieldWidth,
          350000,
          tone.base
        ),
        createTextBox(
          71 + itemIndex * 4,
          `${theme.language} chart field label ${itemIndex + 1}`,
          1000000,
          y + 60000,
          Math.max(900000, fieldWidth - 1900000),
          230000,
          [{ text: item.label, size: 12.5, color: tone.onBase, bold: true }]
        ),
        createTextBox(
          72 + itemIndex * 4,
          `${theme.language} chart field value ${itemIndex + 1}`,
          Math.max(1800000, 760000 + fieldWidth - 1050000),
          y + 50000,
          820000,
          240000,
          [{ text: item.value, size: 13.5, color: tone.onBase, bold: true }]
        )
      ].join('')
    })
    .join('')
  return [createBaseSlideChrome(slide, index, total, theme), createTakeawayBand(slide, theme), rows].join('')
}

function createBubbleChartSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  theme: PptxTheme,
  data: PptxChartDatum[],
  maxValue: number
) {
  const gap = 7200000 / data.length
  const bubbles = data
    .map((item, itemIndex) => {
      const ratio = chartValueRatio(item.numeric, maxValue)
      const size = Math.round(420000 + ratio * 520000)
      const x = Math.round(930000 + itemIndex * gap + gap / 2)
      const y = theme.language === 'organic' ? 2750000 + (itemIndex % 2 === 0 ? -180000 : 180000) : 2750000
      const tone = theme.tones[itemIndex % theme.tones.length]
      return [
        createRect(
          70 + itemIndex * 5,
          `${theme.language} chart bubble ${itemIndex + 1}`,
          x - size / 2,
          y - size / 2,
          size,
          size,
          tone.base,
          null,
          'ellipse'
        ),
        createTextBox(
          71 + itemIndex * 5,
          `${theme.language} chart bubble value ${itemIndex + 1}`,
          x - size * 0.38,
          y - 130000,
          size * 0.76,
          260000,
          [{ text: item.value, size: 13, color: tone.onBase, bold: true }],
          { anchor: 'ctr' }
        ),
        createTextBox(
          72 + itemIndex * 5,
          `${theme.language} chart bubble label ${itemIndex + 1}`,
          x - 600000,
          y + size / 2 + 140000,
          1200000,
          320000,
          [{ text: item.label, size: 11.5, color: theme.ink, bold: true }]
        )
      ].join('')
    })
    .join('')
  return [createBaseSlideChrome(slide, index, total, theme), createTakeawayBand(slide, theme), bubbles].join('')
}

function chartValueRatio(value: number, maximum: number) {
  return Math.max(0, Math.min(1, value / Math.max(1, maximum)))
}

function createQuoteSlideXml(slide: NormalizedSlide, index: number, total: number, theme: PptxTheme) {
  const quote = slide.takeaway || slide.bullets[0] || slide.title
  const attribution = slide.subtitle || slide.bullets[1]
  if (theme.language === 'bold' || theme.language === 'brand') {
    const field = theme.tones[1]
    return [
      createRect(2, 'Background', 0, 0, PPTX_SLIDE_W, PPTX_SLIDE_H, field.base),
      createRect(3, 'Bold quote counter field', 7080000, 0, 2064000, PPTX_SLIDE_H, theme.deep),
      createTextBox(4, 'Bold quote mark', 690000, 650000, 900000, 800000, [
        { text: '"', size: 58, color: field.onBase, bold: true }
      ]),
      createTextBox(5, 'Bold quote', 820000, 1420000, 5700000, 1850000, [
        { text: quote, size: 29, color: field.onBase, bold: true }
      ]),
      attribution
        ? createTextBox(6, 'Bold attribution', 850000, 3700000, 5100000, 360000, [
            { text: attribution, size: 14, color: field.onBase, bold: true }
          ])
        : '',
      createTextBox(7, 'Bold quote folio', 7570000, 2150000, 920000, 720000, [
        { text: String(index + 1).padStart(2, '0'), size: 40, color: theme.coverMuted, bold: true }
      ]),
      createFooter(index, total, theme.coverMuted)
    ].join('')
  }
  if (theme.language === 'playful' || theme.language === 'organic') {
    return [
      createRect(2, 'Background', 0, 0, PPTX_SLIDE_W, PPTX_SLIDE_H, theme.bg),
      createRect(3, 'Organic quote halo', 560000, 620000, 3800000, 3800000, theme.soft, null, 'ellipse'),
      createRect(4, 'Organic quote orbit', 7090000, 680000, 980000, 980000, theme.tones[1].base, null, 'ellipse'),
      createTextBox(5, 'Organic quote mark', 1050000, 1060000, 700000, 620000, [
        { text: '"', size: 50, color: theme.base, bold: true }
      ]),
      createTextBox(6, 'Organic quote', 1250000, 1730000, 6500000, 1350000, [
        { text: quote, size: 27, color: theme.ink, bold: true }
      ]),
      attribution
        ? createTextBox(7, 'Organic attribution', 1280000, 3420000, 5000000, 360000, [
            { text: attribution, size: 14, color: theme.muted, bold: true }
          ])
        : '',
      createFooter(index, total, theme.muted)
    ].join('')
  }
  if (theme.language === 'technical' || theme.language === 'data') {
    return [
      createRect(2, 'Background', 0, 0, PPTX_SLIDE_W, PPTX_SLIDE_H, theme.coverBg),
      createRect(3, 'Technical quote frame', 620000, 560000, 7900000, 4000000, theme.coverBg, theme.line),
      createRect(4, 'Technical quote signal', 620000, 560000, 1350000, 70000, theme.base),
      createTextBox(5, 'Technical quote index', 7300000, 850000, 820000, 520000, [
        { text: String(index + 1).padStart(2, '0'), size: 28, color: theme.base, bold: true }
      ]),
      createTextBox(6, 'Technical quote', 1050000, 1460000, 6600000, 1600000, [
        { text: quote, size: 27, color: theme.coverInk, bold: true }
      ]),
      attribution
        ? createTextBox(7, 'Technical attribution', 1080000, 3470000, 5200000, 350000, [
            { text: attribution, size: 13.5, color: theme.coverMuted, bold: true }
          ])
        : '',
      createFooter(index, total, theme.coverMuted)
    ].join('')
  }
  return [
    createRect(2, 'Background', 0, 0, PPTX_SLIDE_W, PPTX_SLIDE_H, theme.coverBg),
    createRect(3, 'Accent block', 0, 0, 230000, PPTX_SLIDE_H, theme.base),
    createTextBox(4, 'Quote mark', 760000, 880000, 700000, 650000, [
      { text: '"', size: 52, color: theme.base, bold: true }
    ]),
    createTextBox(5, 'Quote', 990000, 1380000, 6900000, 1420000, [
      { text: quote, size: 28, color: theme.coverInk, bold: true }
    ]),
    createRect(6, 'Attribution line', 1020000, 3270000, 760000, 60000, theme.base),
    attribution
      ? createTextBox(7, 'Attribution', 1900000, 3190000, 5200000, 340000, [
          { text: attribution, size: 14, color: theme.coverMuted, bold: true }
        ])
      : '',
    createFooter(index, total, theme.coverMuted)
  ].join('')
}

function createMetricSlideXml(slide: NormalizedSlide, index: number, total: number, theme: PptxTheme) {
  const metrics = slide.bullets.slice(0, 3)
  if (
    ['classic', 'executive', 'consulting', 'formal', 'product', 'editorial', 'premium', 'minimal'].includes(
      theme.language
    )
  ) {
    return createTypographicMetricSlideXml(slide, index, total, theme, metrics)
  }
  if (theme.language === 'bold' || theme.language === 'brand') {
    return createColorFieldMetricSlideXml(slide, index, total, theme, metrics)
  }
  if (theme.language === 'playful' || theme.language === 'organic') {
    return createOrbitalMetricSlideXml(slide, index, total, theme, metrics)
  }
  if (theme.language === 'technical' || theme.language === 'data') {
    return createTechnicalMetricSlideXml(slide, index, total, theme, metrics)
  }
  const metricXml = metrics
    .map((metric, i) => {
      const parsed = parseMetricBullet(metric)
      const x = 780000 + i * 2660000
      return [
        createRect(
          20 + i * 5,
          `Metric card ${i + 1}`,
          x,
          1780000,
          2280000,
          1880000,
          theme.card,
          theme.line,
          theme.shape
        ),
        createRect(21 + i * 5, `Metric strip ${i + 1}`, x, 1780000, 2280000, 110000, theme.base),
        createTextBox(22 + i * 5, `Metric value ${i + 1}`, x + 210000, 2130000, 1880000, 470000, [
          { text: parsed.value, size: 26, color: theme.base, bold: true }
        ]),
        createTextBox(23 + i * 5, `Metric label ${i + 1}`, x + 230000, 2720000, 1820000, 300000, [
          { text: parsed.label, size: 13, color: theme.ink, bold: true }
        ]),
        parsed.note
          ? createTextBox(24 + i * 5, `Metric note ${i + 1}`, x + 230000, 3130000, 1820000, 300000, [
              { text: parsed.note, size: 11, color: theme.muted }
            ])
          : ''
      ].join('')
    })
    .join('')

  return [createBaseSlideChrome(slide, index, total, theme), createTakeawayBand(slide, theme), metricXml].join('')
}

function createTypographicMetricSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  theme: PptxTheme,
  metrics: string[]
) {
  const columns = metrics.map((metric, i) => {
    const parsed = parseMetricBullet(metric)
    const x = 760000 + i * 2660000
    return [
      i > 0 ? createRect(20 + i * 5, `Metric divider ${i + 1}`, x - 180000, 1920000, 22000, 1880000, theme.line) : '',
      createTextBox(21 + i * 5, `Editorial metric value ${i + 1}`, x, 1930000, 2200000, 700000, [
        { text: parsed.value, size: 34, color: theme.base, bold: true }
      ]),
      createTextBox(22 + i * 5, `Editorial metric label ${i + 1}`, x, 2740000, 2180000, 330000, [
        { text: parsed.label, size: 14, color: theme.ink, bold: true }
      ]),
      parsed.note
        ? createTextBox(23 + i * 5, `Editorial metric note ${i + 1}`, x, 3220000, 2180000, 520000, [
            { text: parsed.note, size: 11, color: theme.muted }
          ])
        : '',
      createRect(24 + i * 5, `Editorial metric rule ${i + 1}`, x, 3770000, 850000, 30000, theme.base)
    ].join('')
  })
  return [createBaseSlideChrome(slide, index, total, theme), createTakeawayBand(slide, theme), columns.join('')].join(
    ''
  )
}

function createColorFieldMetricSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  theme: PptxTheme,
  metrics: string[]
) {
  const columns = metrics.map((metric, i) => {
    const parsed = parseMetricBullet(metric)
    const x = 560000 + i * 2710000
    const tone = theme.tones[i % theme.tones.length]
    return [
      createRect(20 + i * 4, `Metric color field ${i + 1}`, x, 1760000, 2500000, 2350000, tone.base),
      createTextBox(21 + i * 4, `Metric color value ${i + 1}`, x + 260000, 2140000, 1980000, 650000, [
        { text: parsed.value, size: 34, color: tone.onBase, bold: true }
      ]),
      createTextBox(22 + i * 4, `Metric color label ${i + 1}`, x + 270000, 2960000, 1960000, 330000, [
        { text: parsed.label, size: 14, color: tone.onBase, bold: true }
      ]),
      parsed.note
        ? createTextBox(23 + i * 4, `Metric color note ${i + 1}`, x + 270000, 3400000, 1960000, 430000, [
            { text: parsed.note, size: 10.5, color: tone.onBase }
          ])
        : ''
    ].join('')
  })
  return [createBaseSlideChrome(slide, index, total, theme), createTakeawayBand(slide, theme), columns.join('')].join(
    ''
  )
}

function createOrbitalMetricSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  theme: PptxTheme,
  metrics: string[]
) {
  const orbits = metrics.map((metric, i) => {
    const parsed = parseMetricBullet(metric)
    const x = 760000 + i * 2700000
    const tone = theme.tones[i % theme.tones.length]
    const y = i === 1 ? 1940000 : 1740000
    return [
      createRect(20 + i * 5, `Metric orbit ${i + 1}`, x + 220000, y, 1680000, 1680000, tone.soft, null, 'ellipse'),
      createRect(
        21 + i * 5,
        `Metric orbit dot ${i + 1}`,
        x + 1700000,
        y + 160000,
        310000,
        310000,
        tone.base,
        null,
        'ellipse'
      ),
      createTextBox(22 + i * 5, `Metric orbit value ${i + 1}`, x + 430000, y + 520000, 1260000, 470000, [
        { text: parsed.value, size: 28, color: tone.text, bold: true }
      ]),
      createTextBox(23 + i * 5, `Metric orbit label ${i + 1}`, x + 270000, y + 1830000, 1600000, 300000, [
        { text: parsed.label, size: 13, color: theme.ink, bold: true }
      ]),
      parsed.note
        ? createTextBox(24 + i * 5, `Metric orbit note ${i + 1}`, x + 240000, y + 2200000, 1680000, 330000, [
            { text: parsed.note, size: 10.5, color: theme.muted }
          ])
        : ''
    ].join('')
  })
  return [createBaseSlideChrome(slide, index, total, theme), createTakeawayBand(slide, theme), orbits.join('')].join('')
}

function createTechnicalMetricSlideXml(
  slide: NormalizedSlide,
  index: number,
  total: number,
  theme: PptxTheme,
  metrics: string[]
) {
  const rows = metrics.map((metric, i) => {
    const parsed = parseMetricBullet(metric)
    const y = 1850000 + i * 760000
    const tone = theme.tones[i % theme.tones.length]
    return [
      createTextBox(20 + i * 5, `Data metric index ${i + 1}`, 840000, y + 60000, 500000, 300000, [
        { text: String(i + 1).padStart(2, '0'), size: 15, color: tone.base, bold: true }
      ]),
      createTextBox(21 + i * 5, `Data metric label ${i + 1}`, 1540000, y + 60000, 2200000, 300000, [
        { text: parsed.label, size: 13, color: theme.ink, bold: true }
      ]),
      createTextBox(22 + i * 5, `Data metric value ${i + 1}`, 4160000, y, 1750000, 430000, [
        { text: parsed.value, size: 25, color: tone.base, bold: true }
      ]),
      parsed.note
        ? createTextBox(23 + i * 5, `Data metric note ${i + 1}`, 6140000, y + 70000, 2050000, 330000, [
            { text: parsed.note, size: 10.5, color: theme.muted }
          ])
        : '',
      createRect(24 + i * 5, `Data metric rule ${i + 1}`, 840000, y + 500000, 7400000, 24000, theme.line)
    ].join('')
  })
  return [createBaseSlideChrome(slide, index, total, theme), createTakeawayBand(slide, theme), rows.join('')].join('')
}

function createSummarySlideXml(slide: NormalizedSlide, index: number, total: number, theme: PptxTheme) {
  const bullets = (slide.bullets.length ? slide.bullets : ['明确优先级', '推进关键动作', '定期复盘结果']).slice(0, 5)
  if (
    ['classic', 'executive', 'consulting', 'formal', 'product', 'editorial', 'minimal', 'premium'].includes(
      theme.language
    )
  ) {
    const rows = bullets
      .map((bullet, i) => {
        const y = 1530000 + i * 560000
        return [
          createTextBox(30 + i * 3, `Summary folio ${i + 1}`, 820000, y, 620000, 300000, [
            { text: String(i + 1).padStart(2, '0'), size: 17, color: theme.base, bold: true }
          ]),
          createTextBox(31 + i * 3, `Summary action ${i + 1}`, 1620000, y, 6500000, 330000, [
            { text: bullet, size: 14, color: theme.ink, bold: i === 0 }
          ]),
          createRect(32 + i * 3, `Summary action rule ${i + 1}`, 820000, y + 400000, 7440000, 22000, theme.line)
        ].join('')
      })
      .join('')
    return [
      createBaseSlideChrome(slide, index, total, theme),
      slide.subtitle || slide.takeaway
        ? createTextBox(12, 'Summary statement', 820000, 1090000, 7200000, 300000, [
            { text: slide.subtitle || slide.takeaway || '', size: 13, color: theme.muted }
          ])
        : '',
      rows
    ].join('')
  }
  if (theme.language === 'bold' || theme.language === 'brand') {
    const rows = bullets
      .map((bullet, i) => {
        const y = 1460000 + i * 590000
        const tone = theme.tones[i % theme.tones.length]
        return [
          createRect(30 + i * 3, `Summary color number ${i + 1}`, 700000, y, 670000, 430000, tone.base),
          createTextBox(31 + i * 3, `Summary color folio ${i + 1}`, 895000, y + 100000, 280000, 200000, [
            { text: String(i + 1).padStart(2, '0'), size: 14, color: tone.onBase, bold: true }
          ]),
          createTextBox(32 + i * 3, `Summary color action ${i + 1}`, 1650000, y + 50000, 6500000, 300000, [
            { text: bullet, size: 14, color: theme.ink, bold: i === 0 }
          ])
        ].join('')
      })
      .join('')
    return [createBaseSlideChrome(slide, index, total, theme), rows].join('')
  }
  if (theme.language === 'playful' || theme.language === 'organic') {
    const rows = bullets
      .map((bullet, i) => {
        const y = 1490000 + i * 600000
        const tone = theme.tones[i % theme.tones.length]
        return [
          createRect(30 + i * 3, `Summary bubble ${i + 1}`, 800000, y, 430000, 430000, tone.base, null, 'ellipse'),
          createTextBox(31 + i * 3, `Summary bubble folio ${i + 1}`, 930000, y + 115000, 180000, 180000, [
            { text: String(i + 1), size: 13, color: tone.onBase, bold: true }
          ]),
          createTextBox(32 + i * 3, `Summary bubble action ${i + 1}`, 1540000, y + 60000, 6500000, 300000, [
            { text: bullet, size: 14, color: theme.ink, bold: i === 0 }
          ])
        ].join('')
      })
      .join('')
    return [createBaseSlideChrome(slide, index, total, theme), rows].join('')
  }
  const rowsXml = bullets
    .map((bullet, i) => {
      const y = 1620000 + i * 480000
      return [
        createRect(30 + i * 4, `Summary row ${i + 1}`, 840000, y, 7240000, 340000, theme.card, theme.line, theme.shape),
        createRect(
          31 + i * 4,
          `Summary marker ${i + 1}`,
          1040000,
          y + 90000,
          160000,
          160000,
          theme.base,
          theme.base,
          'ellipse'
        ),
        createTextBox(32 + i * 4, `Summary point ${i + 1}`, 1380000, y + 64000, 6300000, 210000, [
          { text: bullet, size: 14, color: theme.ink, bold: i === 0 }
        ])
      ].join('')
    })
    .join('')

  return [
    createBaseSlideChrome(slide, index, total, theme),
    slide.subtitle || slide.takeaway
      ? createTextBox(12, 'Summary subtitle', PPTX_MARGIN_X, 860000, 7400000, 300000, [
          { text: slide.subtitle || slide.takeaway || '', size: 13, color: theme.muted }
        ])
      : '',
    rowsXml
  ].join('')
}

function createBaseSlideChrome(slide: NormalizedSlide, index: number, total: number, theme: PptxTheme) {
  const background = createRect(2, 'Background', 0, 0, PPTX_SLIDE_W, PPTX_SLIDE_H, theme.bg)
  const footer = createFooter(index, total, theme.muted)

  if (theme.composition === 'kinetic' && usesExpressiveComposition(theme)) {
    return [
      background,
      createRect(3, 'Kinetic title rhythm', 0, 0, 6940000, 980000, theme.base),
      createRect(5, 'Kinetic title counter', 6940000, 0, 2204000, 980000, theme.tones[1].base),
      createRect(6, 'Kinetic title pulse', 8090000, 980000, 610000, 220000, theme.tones[2].base),
      createTextBox(4, 'Title', 650000, 250000, 6100000, 560000, [
        { text: slide.title, size: 25, color: theme.onBase, bold: true }
      ]),
      createTextBox(7, 'Kinetic page marker', 7620000, 290000, 620000, 350000, [
        { text: String(index + 1).padStart(2, '0'), size: 19, color: theme.tones[1].onBase, bold: true }
      ]),
      footer
    ].join('')
  }

  if (theme.composition === 'spatial' && usesExpressiveComposition(theme)) {
    return [
      background,
      createRect(3, 'Spatial title boundary', 560000, 260000, 8020000, 760000, theme.bg, theme.line),
      createRect(5, 'Spatial title axis', 560000, 260000, 980000, 36000, theme.base),
      createTextBox(4, 'Title', 760000, 460000, 6500000, 430000, [
        { text: slide.title, size: 24, color: theme.ink, bold: true }
      ]),
      createTextBox(6, 'Spatial coordinate', 7790000, 470000, 420000, 300000, [
        { text: String(index + 1).padStart(2, '0'), size: 15, color: theme.base, bold: true }
      ]),
      footer
    ].join('')
  }

  if (theme.language === 'consulting') {
    return [
      background,
      createTextBox(3, 'Consulting index', 510000, 300000, 560000, 470000, [
        { text: String(index + 1).padStart(2, '0'), size: 24, color: theme.base, bold: true }
      ]),
      createRect(5, 'Consulting divider', 1160000, 300000, 32000, 650000, theme.line),
      createTextBox(4, 'Title', 1450000, 350000, 6800000, 560000, [
        { text: slide.title, size: 23, color: theme.ink, bold: true }
      ]),
      createRect(6, 'Consulting top rule', 7250000, 170000, 1220000, 42000, theme.base),
      footer
    ].join('')
  }

  if (theme.language === 'executive') {
    return [
      background,
      createRect(3, 'Executive rail', 0, 0, 180000, PPTX_SLIDE_H, theme.deep),
      createRect(5, 'Executive title rule', 650000, 960000, 2100000, 50000, theme.base),
      createTextBox(4, 'Title', 650000, 350000, 7100000, 560000, [
        { text: slide.title, size: 24, color: theme.ink, bold: true }
      ]),
      createTextBox(6, 'Executive page marker', 8070000, 300000, 520000, 430000, [
        { text: String(index + 1).padStart(2, '0'), size: 18, color: theme.base, bold: true }
      ]),
      footer
    ].join('')
  }

  if (theme.language === 'formal') {
    return [
      background,
      createRect(3, 'Formal top rule', 0, 0, PPTX_SLIDE_W, 52000, theme.deep),
      createRect(5, 'Formal inner rule', 620000, 990000, 7900000, 24000, theme.line),
      createTextBox(4, 'Title', 760000, 360000, 7440000, 540000, [
        { text: slide.title, size: 23, color: theme.ink, bold: true }
      ]),
      createRect(6, 'Formal title marker', 620000, 380000, 60000, 480000, theme.base),
      footer
    ].join('')
  }

  if (theme.language === 'technical' || theme.language === 'data') {
    return [
      background,
      createRect(3, 'Technical rail', 0, 0, 130000, PPTX_SLIDE_H, theme.base),
      createRect(5, 'Technical corner top', 760000, 250000, 520000, 42000, theme.base),
      createRect(6, 'Technical corner side', 760000, 250000, 42000, 220000, theme.base),
      createTextBox(4, 'Title', 760000, 430000, 6800000, 520000, [
        { text: slide.title, size: 23, color: theme.ink, bold: true }
      ]),
      createRect(7, 'Technical signal one', 7520000, 460000, 330000, 70000, theme.tones[0].base),
      createRect(8, 'Technical signal two', 7900000, 460000, 220000, 70000, theme.tones[1].base),
      createRect(9, 'Technical signal three', 8170000, 460000, 120000, 70000, theme.tones[2].base),
      footer
    ].join('')
  }

  if (theme.language === 'bold' || theme.language === 'brand') {
    return [
      background,
      createRect(3, 'Bold title field', 0, 0, PPTX_SLIDE_W, 1040000, theme.base),
      createRect(5, 'Bold counter field', 8240000, 0, 904000, 1040000, theme.deep),
      createTextBox(4, 'Title', 650000, 270000, 7300000, 570000, [
        { text: slide.title, size: 25, color: theme.onBase, bold: true }
      ]),
      createTextBox(6, 'Bold page marker', 8420000, 330000, 420000, 320000, [
        { text: String(index + 1).padStart(2, '0'), size: 17, color: pptxContrastText(theme.deep), bold: true }
      ]),
      footer
    ].join('')
  }

  if (theme.language === 'editorial') {
    return [
      background,
      createRect(3, 'Editorial spine', 0, 0, 100000, PPTX_SLIDE_H, theme.base),
      createTextBox(4, 'Title', 760000, 390000, 6500000, 520000, [
        { text: slide.title, size: 25, color: theme.ink, bold: true }
      ]),
      createTextBox(5, 'Editorial folio', 7730000, 190000, 760000, 650000, [
        { text: String(index + 1).padStart(2, '0'), size: 34, color: theme.line, bold: true }
      ]),
      createRect(6, 'Editorial baseline', 760000, 980000, 2600000, 30000, theme.base),
      footer
    ].join('')
  }

  if (theme.language === 'playful' || theme.language === 'organic') {
    return [
      background,
      createRect(3, 'Soft title halo', 420000, 170000, 720000, 720000, theme.soft, null, 'ellipse'),
      createRect(5, 'Accent dot', 8100000, 260000, 270000, 270000, theme.tones[1].base, null, 'ellipse'),
      createRect(6, 'Accent dot small', 8440000, 650000, 130000, 130000, theme.tones[2].base, null, 'ellipse'),
      createTextBox(4, 'Title', 790000, 390000, 6900000, 540000, [
        { text: slide.title, size: 24, color: theme.ink, bold: true }
      ]),
      footer
    ].join('')
  }

  if (theme.language === 'premium') {
    return [
      background,
      createRect(3, 'Premium top rule', 700000, 230000, 7700000, 24000, theme.base),
      createTextBox(4, 'Title', 700000, 420000, 7000000, 500000, [
        { text: slide.title, size: 23, color: theme.ink, bold: true }
      ]),
      createRect(5, 'Premium title rule', 700000, 990000, 900000, 36000, theme.base),
      footer
    ].join('')
  }

  if (theme.language === 'minimal' || theme.language === 'product') {
    return [
      background,
      createRect(3, 'Minimal title marker', 560000, 430000, 150000, 150000, theme.base, null, theme.shape),
      createTextBox(4, 'Title', 850000, 360000, 7150000, 560000, [
        { text: slide.title, size: 24, color: theme.ink, bold: true }
      ]),
      createRect(5, 'Minimal baseline', 850000, 980000, 7480000, 24000, theme.line),
      footer
    ].join('')
  }

  return [
    background,
    createRect(3, 'Classic accent line', 0, 0, PPTX_SLIDE_W, 90000, theme.base),
    createTextBox(4, 'Title', PPTX_MARGIN_X, 360000, 7800000, 580000, [
      { text: slide.title, size: 24, color: theme.ink, bold: true }
    ]),
    footer
  ].join('')
}

function createTakeawayBand(slide: NormalizedSlide, theme: PptxTheme) {
  const text = slide.takeaway || slide.subtitle
  if (!text) return ''

  if (theme.language === 'editorial' || theme.language === 'consulting') {
    return [
      createRect(10, 'Statement rule', 760000, 1120000, 52000, 620000, theme.base),
      createTextBox(11, 'Statement text', 1030000, 1170000, 7200000, 450000, [
        { text, size: 15, color: theme.ink, bold: true }
      ])
    ].join('')
  }

  if (theme.language === 'minimal') {
    return [
      createTextBox(11, 'Minimal statement', 850000, 1130000, 7300000, 380000, [
        { text, size: 14, color: theme.ink, bold: true }
      ]),
      createRect(10, 'Minimal statement rule', 850000, 1580000, 1600000, 26000, theme.base)
    ].join('')
  }

  if (theme.language === 'formal' || theme.language === 'premium') {
    return [
      createRect(10, 'Formal statement top rule', 760000, 1120000, 7600000, 22000, theme.line),
      createTextBox(11, 'Formal statement', 920000, 1210000, 7200000, 350000, [
        { text, size: 13.5, color: theme.ink, bold: true }
      ]),
      createRect(12, 'Formal statement bottom rule', 760000, 1640000, 7600000, 22000, theme.line)
    ].join('')
  }

  if (theme.language === 'bold' || theme.language === 'brand') {
    return [
      createRect(10, 'Bold statement field', 520000, 1140000, 8100000, 580000, theme.tones[1].base),
      createTextBox(11, 'Bold statement', 840000, 1250000, 7440000, 340000, [
        { text, size: 14, color: theme.tones[1].onBase, bold: true }
      ])
    ].join('')
  }

  if (theme.language === 'playful' || theme.language === 'organic') {
    return [
      createRect(10, 'Soft statement bubble', 980000, 1120000, 7200000, 620000, theme.soft, null, 'roundRect'),
      createRect(12, 'Statement dot', 700000, 1300000, 260000, 260000, theme.base, null, 'ellipse'),
      createTextBox(11, 'Soft statement', 1280000, 1250000, 6500000, 340000, [
        { text, size: 13.5, color: theme.text, bold: true }
      ])
    ].join('')
  }

  if (theme.language === 'technical' || theme.language === 'data') {
    return [
      createRect(10, 'Technical statement panel', 720000, 1110000, 7700000, 620000, theme.soft, theme.line),
      createRect(12, 'Technical statement rail', 720000, 1110000, 100000, 620000, theme.base),
      createTextBox(11, 'Technical statement', 1050000, 1240000, 7000000, 340000, [
        { text, size: 13.5, color: theme.text, bold: true }
      ])
    ].join('')
  }

  if (theme.language === 'classic' || theme.language === 'executive' || theme.language === 'product') {
    return [
      createRect(10, 'Corporate statement rail', 760000, 1130000, 52000, 560000, theme.base),
      createTextBox(11, 'Corporate statement', 1060000, 1210000, 7200000, 390000, [
        { text, size: 14, color: theme.ink, bold: true }
      ])
    ].join('')
  }

  return [
    createRect(10, 'Takeaway band', 720000, 1080000, 7660000, 560000, theme.soft, theme.soft, theme.shape),
    createTextBox(
      11,
      'Takeaway text',
      990000,
      1180000,
      7060000,
      350000,
      [{ text, size: 13, color: theme.text, bold: true }],
      { anchor: 'ctr' }
    )
  ].join('')
}

function createColumnBlock(
  baseId: number,
  name: string,
  x: number,
  y: number,
  cx: number,
  cy: number,
  heading: string,
  bullets: string[],
  fill: string,
  color: string,
  line: string,
  shape: 'rect' | 'roundRect'
) {
  const points = bullets.slice(0, 5).map((bullet) => ({ text: bullet, size: 12, color }))
  return [
    createRect(baseId, `${name} column`, x, y, cx, cy, fill, line, shape),
    createTextBox(baseId + 1, `${name} heading`, x + 260000, y + 240000, cx - 520000, 300000, [
      { text: heading, size: 16, color, bold: true }
    ]),
    createTextBox(baseId + 2, `${name} bullets`, x + 260000, y + 760000, cx - 520000, cy - 940000, points)
  ].join('')
}

function createRect(
  id: number,
  name: string,
  x: number,
  y: number,
  cx: number,
  cy: number,
  fill: string,
  line: string | null = null,
  preset: 'rect' | 'roundRect' | 'ellipse' = 'rect'
) {
  const lineXml = line
    ? `<a:ln w="6350"><a:solidFill><a:srgbClr val="${line}"/></a:solidFill></a:ln>`
    : '<a:ln><a:noFill/></a:ln>'
  return `<p:sp>
    <p:nvSpPr><p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
    <p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="${preset}"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>${lineXml}</p:spPr>
  </p:sp>`
}

function createTextBox(
  id: number,
  name: string,
  x: number,
  y: number,
  cx: number,
  cy: number,
  paragraphs: Array<{ text: string; size: number; color: string; bold?: boolean }>,
  options: { anchor?: 't' | 'ctr' | 'b'; autoFit?: boolean; margin?: number } = {}
) {
  const paragraphXml = paragraphs.length
    ? paragraphs.map((paragraph) => createTextParagraph(paragraph)).join('')
    : '<a:p/>'
  const anchor = options.anchor || 't'
  const margin = Math.max(0, Math.round(options.margin || 0))
  const autoFitXml = options.autoFit === false ? '' : createPptxAutofitXml(name, paragraphs, cx, cy, margin)
  return `<p:sp>
    <p:nvSpPr><p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>
    <p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>
    <p:txBody><a:bodyPr wrap="square" anchor="${anchor}" horzOverflow="clip" lIns="${margin}" rIns="${margin}" tIns="${margin}" bIns="${margin}">${autoFitXml}</a:bodyPr><a:lstStyle/>${paragraphXml}</p:txBody>
  </p:sp>`
}

function createPptxAutofitXml(
  name: string,
  paragraphs: Array<{ text: string; size: number }>,
  widthEmu: number,
  heightEmu: number,
  marginEmu: number
) {
  const emuPerPoint = 12_700
  const usableWidth = Math.max(1, (widthEmu - marginEmu * 2) / emuPerPoint)
  const usableHeight = Math.max(1, (heightEmu - marginEmu * 2) / emuPerPoint)
  const fitsAtScale = (fontScale: number) => {
    const scale = fontScale / 100_000
    const requiredHeight = paragraphs.reduce((height, paragraph) => {
      const fontSize = Math.max(1, paragraph.size * scale)
      const textWidth = Math.max(0.5, pptxTextUnits(paragraph.text)) * fontSize
      const lines = Math.max(1, Math.ceil(textWidth / usableWidth))
      return height + lines * fontSize * 1.16 + fontSize * 0.08
    }, 0)
    return requiredHeight <= usableHeight * 0.96
  }

  let fontScale = 100_000
  while (fontScale > 65_000 && !fitsAtScale(fontScale)) fontScale -= 2_500
  if (!fitsAtScale(fontScale)) {
    throw new Error(
      `PPTX text box "${name}" exceeds its readable capacity; shorten the copy or select a roomier layout.`
    )
  }
  const lineSpacingReduction = Math.min(20_000, Math.round((100_000 - fontScale) * 0.45))
  return `<a:normAutofit fontScale="${fontScale}" lnSpcReduction="${lineSpacingReduction}"/>`
}

function createTextParagraph(paragraph: { text: string; size: number; color: string; bold?: boolean }) {
  const bold = paragraph.bold ? ' b="1"' : ''
  return `<a:p><a:r><a:rPr lang="zh-CN" sz="${Math.round(paragraph.size * 100)}"${bold}><a:solidFill><a:srgbClr val="${paragraph.color}"/></a:solidFill></a:rPr><a:t>${xmlEscape(paragraph.text)}</a:t></a:r></a:p>`
}

function createFooter(index: number, total: number, color: string) {
  return createTextBox(900, 'Footer', 7600000, 4680000, 900000, 240000, [
    { text: `${index + 1}/${total}`, size: 10, color }
  ])
}

function shouldUseDenseStepRows(items: string[], compactLimit: number) {
  return (
    items.some((item) => pptxTextUnits(item) > compactLimit) ||
    items.reduce((sum, item) => sum + pptxTextUnits(item), 0) > compactLimit * 3.4
  )
}

function pptxTextUnits(value: string) {
  let units = 0
  for (const char of value) {
    if (/\s/u.test(char)) units += 0.3
    else if (/[\u2E80-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/u.test(char)) units += 1
    else if (/[^\p{L}\p{N}]/u.test(char)) units += 0.45
    else units += 0.55
  }
  return units
}

function splitPptxText(value: string, separator: RegExp): [string, string] | null {
  const match = separator.exec(value)
  if (!match || match.index === undefined) return null
  return [value.slice(0, match.index).trim(), value.slice(match.index + match[0].length).trim()]
}

function parseCardBullet(value: string) {
  const pair = splitPptxText(value, /[:：|｜]/u)
  if (pair && pair[0] && pair[1] && pptxTextUnits(pair[0]) <= 18) {
    return { heading: pair[0], detail: pair[1] }
  }
  return { heading: value, detail: '' }
}

function parseStepBullet(value: string, index: number, kind: 'process' | 'timeline') {
  const periodBody = splitPptxText(value, /[|｜]/u)
  const period = periodBody?.[0] || String(index + 1).padStart(2, '0')
  const body = periodBody?.[1] || value
  const headingDetail = splitPptxText(body, /[:：]/u)
  return {
    period: kind === 'timeline' ? period : String(index + 1).padStart(2, '0'),
    heading: headingDetail?.[0] || body,
    detail: headingDetail?.[1] || ''
  }
}

function parseMetricBullet(value: string) {
  const labelRest = splitPptxText(value, /[:：|｜]/u)
  if (!labelRest) return { label: value, value: '', note: '', valid: false }
  const valueNote = splitPptxText(labelRest[1], /[|｜]/u)
  const metricValue = valueNote?.[0] || labelRest[1]
  const note = valueNote?.[1] || ''
  const valid =
    Boolean(labelRest[0] && metricValue) &&
    /(?:\d|[%％$￥¥€£]|\b(?:k|m|b|x|pp|bps)\b|倍|天|周|月|年|小时|分钟)/iu.test(metricValue) &&
    pptxTextUnits(labelRest[0]) <= 18 &&
    pptxTextUnits(metricValue) <= 16 &&
    pptxTextUnits(note) <= 32
  return { label: labelRest[0], value: metricValue, note, valid }
}

function parseChartBullet(value: string) {
  const pair = splitPptxText(value, /[:：|｜]/u)
  const label = pair?.[0] || value.trim()
  const rawValue = pair?.[1] || value.trim()
  const numericMatch = rawValue.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)
  const numeric = numericMatch ? Math.abs(Number(numericMatch[0])) : 1
  return {
    label: label || 'Data point',
    value: rawValue || '1',
    numeric: Number.isFinite(numeric) && numeric > 0 ? numeric : 1
  }
}

function toCsv(rows: string[][]) {
  return rows.map((row) => row.map(csvEscape).join(',')).join('\r\n')
}

function splitCsvLine(line: string) {
  const cells: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"' && line[i + 1] === '"') {
      current += '"'
      i++
    } else if (char === '"') {
      inQuotes = !inQuotes
    } else if (char === ',' && !inQuotes) {
      cells.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  cells.push(current.trim())
  return cells
}

function csvEscape(value: string) {
  if (!/[",\r\n]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

function stringifyCell(cell: CellValue) {
  return cell === null || cell === undefined ? '' : String(cell)
}

function xmlEscape(value: string) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export default AssistantServer
