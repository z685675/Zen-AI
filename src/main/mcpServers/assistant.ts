import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { loggerService } from '@logger'
import { toAsarUnpackedPath } from '@main/utils'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js'
import fontkit from '@pdf-lib/fontkit'
import AdmZip from 'adm-zip'
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from 'docx'
import { app } from 'electron'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'

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
        enum: ['info', 'providers', 'health', 'logs', 'errors', 'mcp_status', 'read_source', 'config'],
        description:
          'info: app version/paths/system. providers: list configured providers. health: test provider connectivity (cached 30s). logs: read recent log entries. errors: extract only ERROR/WARN entries from logs. mcp_status: check MCP server states. read_source: read a source file (read-only). config: read user settings (theme, language, proxy, default model, etc).'
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

const CREATE_FILE_TOOL: Tool = {
  name: 'create_file',
  description: `Create a valid common output file using Zen AI's built-in document generator.
Use this for user-requested MD/TXT/CSV/DOCX/XLSX/PPTX/PDF output before improvising Python or shell scripts.
It is designed for reliable basic documents, spreadsheets, slides, and text files without requiring pandas, python-docx, openpyxl, python-pptx, or system Python.
For complex formatting, charts, formulas, images, or advanced PDF layout, create a basic draft with this tool first, then explain any limitation or use an approved external dependency only if truly required.
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
      slides: {
        type: 'array',
        description: 'Optional slide definitions for PPTX. If omitted, content is split into basic slides.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
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

// Health check cache: { providerId -> { result, timestamp } }
const healthCache = new Map<string, { result: unknown; timestamp: number }>()
const HEALTH_CACHE_TTL = 30_000 // 30 seconds
const SUPPORTED_FILE_FORMATS = ['md', 'txt', 'csv', 'docx', 'xlsx', 'pptx', 'pdf'] as const

type SupportedFileFormat = (typeof SUPPORTED_FILE_FORMATS)[number]
type CellValue = string | number | boolean | null

interface SlideInput {
  title?: string
  bullets?: string[]
  notes?: string
}

interface CreateFileArgs {
  file_path?: string
  format?: string
  title?: string
  content?: string
  rows?: CellValue[][]
  slides?: SlideInput[]
}

interface OutputBufferOptions {
  format: SupportedFileFormat
  title: string
  content: string
  rows: string[][]
  slides: NormalizedSlide[]
}

interface NormalizedSlide {
  title: string
  bullets: string[]
  notes?: string
}

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
      tools: [NAVIGATE_TOOL, DIAGNOSE_TOOL, CREATE_FILE_TOOL]
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
          case 'create_file':
            return await this.createFile(args as CreateFileArgs)
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
      default:
        throw new McpError(ErrorCode.InvalidParams, `Unknown diagnose action: ${action}`)
    }
  }

  private async createFile(args: CreateFileArgs) {
    const filePath = typeof args.file_path === 'string' ? args.file_path.trim() : ''
    if (!filePath) throw new McpError(ErrorCode.InvalidParams, "'file_path' is required for create_file")

    const format = normalizeFormat(args.format, filePath)
    const outputPath = this.resolveOutputPath(filePath)
    const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : path.basename(outputPath)
    const content = typeof args.content === 'string' ? args.content : ''
    const rows = normalizeRows(args.rows, content)
    const slides = normalizeSlides(args.slides, title, content)

    await fsp.mkdir(path.dirname(outputPath), { recursive: true })

    const buffer = await createOutputBuffer({ format, title, content, rows, slides })
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
              verified: stat.isFile() && stat.size > 0
            },
            null,
            2
          )
        }
      ]
    }
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
    return slides.map((slide, index) => ({
      title: slide.title?.trim() || `${title} ${index + 1}`,
      bullets: Array.isArray(slide.bullets) ? slide.bullets.map((item) => String(item)).filter(Boolean) : [],
      notes: slide.notes ? String(slide.notes) : undefined
    }))
  }

  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length === 0) {
    return [{ title, bullets: [''] }]
  }

  const slidesFromHeadings: NormalizedSlide[] = []
  let current: NormalizedSlide = { title, bullets: [] }

  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.+)$/)
    if (heading) {
      if (current.bullets.length > 0 || slidesFromHeadings.length === 0) {
        slidesFromHeadings.push(current)
      }
      current = { title: heading[1].trim(), bullets: [] }
      continue
    }
    current.bullets.push(line.replace(/^[-*]\s+/, ''))
  }

  if (current.bullets.length > 0 || slidesFromHeadings.length === 0) {
    slidesFromHeadings.push(current)
  }

  return slidesFromHeadings.slice(0, 30)
}

async function createOutputBuffer(options: OutputBufferOptions): Promise<Buffer> {
  switch (options.format) {
    case 'md':
    case 'txt':
      return Buffer.from(options.content || options.title, 'utf-8')
    case 'csv':
      return Buffer.from('\uFEFF' + toCsv(options.rows), 'utf-8')
    case 'docx':
      return await createDocxBuffer(options.title, options.content, options.rows)
    case 'xlsx':
      return createXlsxBuffer(options.rows)
    case 'pptx':
      return createPptxBuffer(options.slides)
    case 'pdf':
      return await createPdfBuffer(options.title, options.content)
  }
}

async function createDocxBuffer(title: string, content: string, rows: string[][]) {
  const children: Array<Paragraph | Table> = [
    new Paragraph({
      text: title,
      heading: HeadingLevel.HEADING_1
    })
  ]

  const lines = content.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      children.push(new Paragraph({ text: '' }))
      continue
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      const level = Math.min(heading[1].length + 1, 3) as 2 | 3 | 4
      children.push(
        new Paragraph({
          text: heading[2],
          heading: level === 2 ? HeadingLevel.HEADING_2 : level === 3 ? HeadingLevel.HEADING_3 : HeadingLevel.HEADING_4
        })
      )
      continue
    }

    children.push(
      new Paragraph({
        children: [new TextRun(trimmed.replace(/^[-*]\s+/, ''))],
        bullet: /^[-*]\s+/.test(trimmed) ? { level: 0 } : undefined,
        spacing: { after: 120 }
      })
    )
  }

  if (rows.length > 1 || rows[0]?.length > 1) {
    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: rows.map(
          (row, rowIndex) =>
            new TableRow({
              children: row.map(
                (cell) =>
                  new TableCell({
                    children: [new Paragraph(String(cell))],
                    shading:
                      rowIndex === 0
                        ? {
                            type: ShadingType.CLEAR,
                            color: 'auto',
                            fill: 'F3F4F6'
                          }
                        : undefined
                  })
              )
            })
        )
      })
    )
  }

  const doc = new Document({
    sections: [{ properties: {}, children }]
  })

  return Buffer.from(await Packer.toBuffer(doc))
}

function createXlsxBuffer(rows: string[][]) {
  const zip = new AdmZip()
  const normalizedRows = rows.length ? rows : [['Content'], ['']]

  zip.addFile('[Content_Types].xml', Buffer.from(XLSX_CONTENT_TYPES, 'utf-8'))
  zip.addFile('_rels/.rels', Buffer.from(XLSX_ROOT_RELS, 'utf-8'))
  zip.addFile('xl/workbook.xml', Buffer.from(XLSX_WORKBOOK, 'utf-8'))
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(XLSX_WORKBOOK_RELS, 'utf-8'))
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(createWorksheetXml(normalizedRows), 'utf-8'))

  return zip.toBuffer()
}

function createPptxBuffer(slides: NormalizedSlide[]) {
  const zip = new AdmZip()
  const normalizedSlides = slides.length ? slides : [{ title: 'Slide 1', bullets: [''] }]

  zip.addFile('[Content_Types].xml', Buffer.from(createPptxContentTypes(normalizedSlides.length), 'utf-8'))
  zip.addFile('_rels/.rels', Buffer.from(PPTX_ROOT_RELS, 'utf-8'))
  zip.addFile('ppt/presentation.xml', Buffer.from(createPresentationXml(normalizedSlides.length), 'utf-8'))
  zip.addFile(
    'ppt/_rels/presentation.xml.rels',
    Buffer.from(createPresentationRelsXml(normalizedSlides.length), 'utf-8')
  )
  zip.addFile('ppt/slideMasters/slideMaster1.xml', Buffer.from(PPTX_SLIDE_MASTER, 'utf-8'))
  zip.addFile('ppt/slideMasters/_rels/slideMaster1.xml.rels', Buffer.from(PPTX_SLIDE_MASTER_RELS, 'utf-8'))
  zip.addFile('ppt/slideLayouts/slideLayout1.xml', Buffer.from(PPTX_SLIDE_LAYOUT, 'utf-8'))
  zip.addFile('ppt/theme/theme1.xml', Buffer.from(PPTX_THEME, 'utf-8'))
  zip.addFile('docProps/core.xml', Buffer.from(createCorePropsXml(), 'utf-8'))
  zip.addFile('docProps/app.xml', Buffer.from(createAppPropsXml(normalizedSlides.length), 'utf-8'))

  normalizedSlides.forEach((slide, index) => {
    zip.addFile(`ppt/slides/slide${index + 1}.xml`, Buffer.from(createSlideXml(slide), 'utf-8'))
    zip.addFile(`ppt/slides/_rels/slide${index + 1}.xml.rels`, Buffer.from(PPTX_SLIDE_RELS, 'utf-8'))
  })

  return zip.toBuffer()
}

async function createPdfBuffer(title: string, content: string) {
  const pdfDoc = await PDFDocument.create()
  pdfDoc.registerFontkit(fontkit)
  const font = await loadPdfFont(pdfDoc)
  const pageWidth = 595.28
  const pageHeight = 841.89
  const margin = 48
  const lineHeight = 16
  let page = pdfDoc.addPage([pageWidth, pageHeight])
  let y = pageHeight - margin

  const drawLine = (text: string, size = 11) => {
    if (y < margin) {
      page = pdfDoc.addPage([pageWidth, pageHeight])
      y = pageHeight - margin
    }
    page.drawText(text, { x: margin, y, size, font, color: rgb(0.12, 0.12, 0.12) })
    y -= lineHeight
  }

  drawLine(title, 16)
  y -= 10
  for (const line of wrapText(content || title, 88)) {
    drawLine(line)
  }

  return Buffer.from(await pdfDoc.save())
}

async function loadPdfFont(pdfDoc: PDFDocument) {
  try {
    const fontPath = await findBundledPdfFontPath()
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
  const appRoot = app.getAppPath()
  const directCandidates = [
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
        const match = entries.find((entry) => /^HarmonyOS_Sans_Regular.*\.ttf$/i.test(entry))
        if (match) return path.join(resolvedAssetDir, match)
      } catch {
        // Asset directory may not exist in dev or in some packaged layouts.
      }
    }
  }

  throw new Error('Bundled HarmonyOS Sans font not found')
}

function candidatePathVariants(filePath: string) {
  const unpackedPath = toAsarUnpackedPath(filePath)
  return unpackedPath === filePath ? [filePath] : [filePath, unpackedPath]
}

function createWorksheetXml(rows: string[][]) {
  const sheetData = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((cell, colIndex) => {
          const ref = `${columnName(colIndex + 1)}${rowIndex + 1}`
          return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(cell)}</t></is></c>`
        })
        .join('')
      return `<row r="${rowIndex + 1}">${cells}</row>`
    })
    .join('')

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`
}

function createSlideXml(slide: NormalizedSlide) {
  const bulletXml = slide.bullets
    .slice(0, 18)
    .map(
      (bullet, index) => `
      <a:p>
        <a:pPr marL="342900" indent="-171450"/>
        <a:r><a:rPr lang="zh-CN" sz="2400"/><a:t>${xmlEscape(index === 0 ? bullet : bullet)}</a:t></a:r>
      </a:p>`
    )
    .join('')

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="685800" y="457200"/><a:ext cx="7772400" cy="731520"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="3600" b="1"/><a:t>${xmlEscape(slide.title)}</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Content"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="914400" y="1371600"/><a:ext cx="7315200" cy="4114800"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/>${bulletXml || '<a:p/>'}</p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`
}

function createPptxContentTypes(slideCount: number) {
  const slideOverrides = Array.from(
    { length: slideCount },
    (_, index) =>
      `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
  ).join('')

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  ${slideOverrides}
</Types>`
}

function createPresentationXml(slideCount: number) {
  const slideIds = Array.from(
    { length: slideCount },
    (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`
  ).join('')

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:sldIdLst>${slideIds}</p:sldIdLst>
  <p:sldSz cx="9144000" cy="5143500" type="screen16x9"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`
}

function createPresentationRelsXml(slideCount: number) {
  const slideRels = Array.from(
    { length: slideCount },
    (_, index) =>
      `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`
  ).join('')

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  ${slideRels}
</Relationships>`
}

function createCorePropsXml() {
  const now = new Date().toISOString()
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>Zen AI</dc:creator>
  <cp:lastModifiedBy>Zen AI</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`
}

function createAppPropsXml(slideCount: number) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Zen AI</Application>
  <Slides>${slideCount}</Slides>
</Properties>`
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

function columnName(columnNumber: number) {
  let name = ''
  let n = columnNumber
  while (n > 0) {
    const remainder = (n - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    n = Math.floor((n - 1) / 26)
  }
  return name
}

function wrapText(text: string, maxChars: number) {
  const output: string[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine) {
      output.push('')
      continue
    }
    for (let i = 0; i < rawLine.length; i += maxChars) {
      output.push(rawLine.slice(i, i + maxChars))
    }
  }
  return output
}

const XLSX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`

const XLSX_ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`

const XLSX_WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`

const XLSX_WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`

const PPTX_ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`

const PPTX_SLIDE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`

const PPTX_SLIDE_MASTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`

const PPTX_SLIDE_MASTER_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`

const PPTX_SLIDE_LAYOUT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="titleAndContent">
  <p:cSld name="Title and Content"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`

const PPTX_THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Zen AI">
  <a:themeElements>
    <a:clrScheme name="Zen AI"><a:dk1><a:srgbClr val="1F2937"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="374151"/></a:dk2><a:lt2><a:srgbClr val="F9FAFB"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="059669"/></a:accent2><a:accent3><a:srgbClr val="D97706"/></a:accent3><a:accent4><a:srgbClr val="DC2626"/></a:accent4><a:accent5><a:srgbClr val="7C3AED"/></a:accent5><a:accent6><a:srgbClr val="0891B2"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme>
    <a:fontScheme name="Zen AI"><a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface="Microsoft YaHei"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface="Microsoft YaHei"/></a:minorFont></a:fontScheme>
    <a:fmtScheme name="Zen AI"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
  </a:themeElements>
</a:theme>`

export default AssistantServer
