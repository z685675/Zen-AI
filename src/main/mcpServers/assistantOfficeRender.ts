import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export type OfficeRenderFormat = 'docx' | 'pptx'
export type RenderValidationMode = 'auto' | 'required' | 'skip'

export interface OfficeRenderResult {
  status: 'rendered' | 'unavailable' | 'failed'
  renderer?: 'libreoffice' | 'microsoft-office'
  pdf?: Buffer
  reason?: string
}

const RENDER_TIMEOUT_MS = 60_000

export async function renderOfficeBufferToPdf(
  format: OfficeRenderFormat,
  buffer: Buffer,
  mode: RenderValidationMode
): Promise<OfficeRenderResult> {
  if (mode === 'skip') return { status: 'unavailable', reason: 'render validation was skipped' }
  if (process.env.VITEST && mode !== 'required') {
    return { status: 'unavailable', reason: 'Office rendering is disabled in the automated test process' }
  }

  const tempDir = await fsp.mkdtemp(path.join(tmpdir(), 'zen-office-render-'))
  const inputPath = path.join(tempDir, `input.${format}`)
  const outputPath = path.join(tempDir, 'input.pdf')
  try {
    await fsp.writeFile(inputPath, buffer)
    const libreOffice = await findLibreOfficeExecutable()
    if (libreOffice) {
      const result = await renderWithLibreOffice(libreOffice, inputPath, outputPath, tempDir)
      if (result.status === 'rendered') return result
      if (mode !== 'required') return result
    }

    if (mode === 'required' && process.platform === 'win32') {
      return await renderWithMicrosoftOffice(format, inputPath, outputPath, tempDir)
    }

    return {
      status: 'unavailable',
      reason:
        mode === 'required'
          ? 'No supported Office renderer is available'
          : 'LibreOffice is not installed; Microsoft Office rendering is used only when render_validation is required'
    }
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function renderWithLibreOffice(
  executable: string,
  inputPath: string,
  outputPath: string,
  tempDir: string
): Promise<OfficeRenderResult> {
  const profileUri = pathToFileURL(path.join(tempDir, 'profile')).href
  const result = await runProcess(
    executable,
    [
      `-env:UserInstallation=${profileUri}`,
      '--headless',
      '--nologo',
      '--nodefault',
      '--nolockcheck',
      '--convert-to',
      'pdf',
      '--outdir',
      tempDir,
      inputPath
    ],
    RENDER_TIMEOUT_MS
  )
  if (result.exitCode !== 0) {
    return {
      status: 'failed',
      renderer: 'libreoffice',
      reason: result.stderr || result.stdout || `LibreOffice exited with code ${result.exitCode}`
    }
  }
  try {
    return { status: 'rendered', renderer: 'libreoffice', pdf: await fsp.readFile(outputPath) }
  } catch (error) {
    return {
      status: 'failed',
      renderer: 'libreoffice',
      reason: `LibreOffice did not create a PDF: ${errorMessage(error)}`
    }
  }
}

async function renderWithMicrosoftOffice(
  format: OfficeRenderFormat,
  inputPath: string,
  outputPath: string,
  tempDir: string
): Promise<OfficeRenderResult> {
  const scriptPath = path.join(tempDir, 'render-office.ps1')
  await fsp.writeFile(scriptPath, MICROSOFT_OFFICE_RENDER_SCRIPT, 'utf8')
  const result = await runProcess(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, inputPath, outputPath, format],
    RENDER_TIMEOUT_MS
  )
  if (result.exitCode !== 0) {
    return {
      status: result.exitCode === 44 ? 'unavailable' : 'failed',
      renderer: 'microsoft-office',
      reason: result.stderr || result.stdout || `Microsoft Office renderer exited with code ${result.exitCode}`
    }
  }
  try {
    return { status: 'rendered', renderer: 'microsoft-office', pdf: await fsp.readFile(outputPath) }
  } catch (error) {
    return {
      status: 'failed',
      renderer: 'microsoft-office',
      reason: `Microsoft Office did not create a PDF: ${errorMessage(error)}`
    }
  }
}

async function findLibreOfficeExecutable() {
  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const candidates = [
    ...pathEntries.flatMap((directory) => [path.join(directory, 'soffice.exe'), path.join(directory, 'soffice')]),
    ...(process.platform === 'win32'
      ? [
          path.join(process.env.ProgramFiles || 'C:\\Program Files', 'LibreOffice', 'program', 'soffice.exe'),
          path.join(
            process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
            'LibreOffice',
            'program',
            'soffice.exe'
          )
        ]
      : ['/usr/bin/soffice', '/usr/local/bin/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice'])
  ]
  for (const candidate of new Set(candidates)) {
    try {
      await fsp.access(candidate)
      return candidate
    } catch {
      // Continue through known executable locations.
    }
  }
  return undefined
}

function runProcess(executable: string, args: string[], timeoutMs: number) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (exitCode: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode, stdout: stdout.trim(), stderr: stderr.trim() })
    }
    const timer = setTimeout(() => {
      child.kill()
      stderr = `${stderr}\nRenderer timed out after ${timeoutMs}ms`
      finish(124)
    }, timeoutMs)
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.on('error', (error) => {
      stderr = `${stderr}\n${error.message}`
      finish(error.message.includes('ENOENT') ? 44 : 1)
    })
    child.on('close', (code) => finish(code ?? 1))
  })
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

const MICROSOFT_OFFICE_RENDER_SCRIPT = String.raw`
param([string]$InputPath, [string]$OutputPath, [string]$Format)
$ErrorActionPreference = 'Stop'
$application = $null
$document = $null
try {
  if ($Format -eq 'pptx') {
    try { $application = New-Object -ComObject PowerPoint.Application } catch { exit 44 }
    $document = $application.Presentations.Open($InputPath, $true, $true, $false)
    $document.SaveAs($OutputPath, 32)
  } elseif ($Format -eq 'docx') {
    try { $application = New-Object -ComObject Word.Application } catch { exit 44 }
    $application.Visible = $false
    $application.DisplayAlerts = 0
    $document = $application.Documents.Open($InputPath, $false, $true)
    $document.ExportAsFixedFormat($OutputPath, 17)
  } else {
    throw "Unsupported format: $Format"
  }
} finally {
  if ($null -ne $document) {
    $document.Close()
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document)
  }
  if ($null -ne $application) {
    $application.Quit()
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($application)
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
`
