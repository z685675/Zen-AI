import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('fs')
vi.unmock('node:os')
vi.unmock('os')
vi.unmock('node:path')
vi.unmock('path')

vi.mock('@main/services/ConfigManager', () => ({
  configManager: {
    getLanguage: () => 'zh-CN'
  }
}))

const resourceRoot = path.join(os.tmpdir(), `zen-agent-provisioner-${process.pid}`)
const resourcesDir = path.join(resourceRoot, 'resources')

vi.mock('@main/utils', () => ({
  getResourcePath: () => resourcesDir,
  toAsarUnpackedPath: (filePath: string) => filePath
}))

async function loadProvisioner() {
  return await import('../BuiltinAgentProvisioner')
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function makeFusionResources(): void {
  writeFile(
    path.join(resourcesDir, 'builtin-agents', 'cherry-fusion', 'agent.json'),
    JSON.stringify({
      name: 'Fusion',
      description: {
        'zh-CN': '官方助手'
      },
      instructions: {
        'zh-CN': '完成任务'
      },
      configuration: {
        builtin_role: 'fusion'
      },
      skills: ['pptx', 'docx', 'research-report']
    })
  )
  writeFile(path.join(resourcesDir, 'builtin-agents', 'cherry-assistant', '.claude', 'plugins.json'), '[]')
  writeFile(
    path.join(resourcesDir, 'builtin-agents', 'cherry-assistant', '.claude', 'skills', 'old', 'SKILL.md'),
    '# Old'
  )
  writeFile(path.join(resourcesDir, 'skills', 'pptx', 'SKILL.md'), '# PPTX')
  writeFile(path.join(resourcesDir, 'skills', 'pptx', 'scripts', 'validate.py'), 'print("ok")')
  writeFile(path.join(resourcesDir, 'skills', 'docx', 'SKILL.md'), '# DOCX')
  writeFile(path.join(resourcesDir, 'skills', 'research-report', 'SKILL.md'), '# Research report')
}

describe('BuiltinAgentProvisioner', () => {
  let workspace: string

  beforeEach(() => {
    fs.rmSync(resourceRoot, { recursive: true, force: true })
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-agent-workspace-'))
    makeFusionResources()
  })

  afterEach(() => {
    fs.rmSync(resourceRoot, { recursive: true, force: true })
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  it('provisions fusion skills into both Claude and Codex skill roots', async () => {
    const { isProvisioned, provisionBuiltinAgent } = await loadProvisioner()
    const config = await provisionBuiltinAgent(workspace, 'fusion')

    expect(config?.name).toBe('Fusion')
    expect(config?.description).toBe('官方助手')
    expect(fs.existsSync(path.join(workspace, '.claude', 'skills', 'pptx', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(workspace, '.claude', 'skills', 'docx', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(workspace, '.agents', 'skills', 'pptx', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(workspace, '.agents', 'skills', 'pptx', 'scripts', 'validate.py'))).toBe(true)
    expect(fs.existsSync(path.join(workspace, '.agents', 'skills', 'docx', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(workspace, '.claude', 'skills', 'research-report', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(workspace, '.agents', 'skills', 'research-report', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(workspace, '.agents', 'skills', 'old', 'SKILL.md'))).toBe(false)
    expect(isProvisioned(workspace, 'fusion')).toBe(true)
    expect(fs.existsSync(path.join(workspace, '.claude', '.zen-ai-provision.json'))).toBe(true)
  })

  it('treats existing runtime roots without a source manifest as stale', async () => {
    const { isProvisioned } = await loadProvisioner()
    fs.mkdirSync(path.join(workspace, '.claude', 'skills'), { recursive: true })
    fs.mkdirSync(path.join(workspace, '.agents', 'skills'), { recursive: true })

    expect(isProvisioned(workspace, 'fusion')).toBe(false)
  })

  it('reprovisions both runtime roots when a bundled Skill changes', async () => {
    const { isProvisioned, provisionBuiltinAgent } = await loadProvisioner()
    await provisionBuiltinAgent(workspace, 'fusion')
    expect(isProvisioned(workspace, 'fusion')).toBe(true)

    writeFile(path.join(resourcesDir, 'skills', 'pptx', 'SKILL.md'), '# PPTX v2')
    expect(isProvisioned(workspace, 'fusion')).toBe(false)

    await provisionBuiltinAgent(workspace, 'fusion')
    expect(isProvisioned(workspace, 'fusion')).toBe(true)
    expect(fs.readFileSync(path.join(workspace, '.claude', 'skills', 'pptx', 'SKILL.md'), 'utf-8')).toBe('# PPTX v2')
    expect(fs.readFileSync(path.join(workspace, '.agents', 'skills', 'pptx', 'SKILL.md'), 'utf-8')).toBe('# PPTX v2')
  })

  it('detects and repairs a workspace that lost one declared Skill', async () => {
    const { isProvisioned, provisionBuiltinAgent } = await loadProvisioner()
    await provisionBuiltinAgent(workspace, 'fusion')

    fs.rmSync(path.join(workspace, '.claude', 'skills', 'research-report'), { recursive: true, force: true })
    expect(isProvisioned(workspace, 'fusion')).toBe(false)

    await provisionBuiltinAgent(workspace, 'fusion')

    expect(isProvisioned(workspace, 'fusion')).toBe(true)
    expect(fs.existsSync(path.join(workspace, '.claude', 'skills', 'research-report', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(workspace, '.agents', 'skills', 'research-report', 'SKILL.md'))).toBe(true)
  })

  it('mirrors existing Claude skills into Codex skill root without removing Claude files', async () => {
    const { ensureBuiltinAgentRuntimeSkillRoots } = await loadProvisioner()
    writeFile(path.join(workspace, '.claude', 'skills', 'custom-skill', 'SKILL.md'), '# Custom')
    writeFile(path.join(workspace, '.claude', 'skills', 'custom-skill', 'notes.txt'), 'keep me')

    const changed = ensureBuiltinAgentRuntimeSkillRoots(workspace)

    expect(changed).toBe(true)
    expect(fs.existsSync(path.join(workspace, '.claude', 'skills', 'custom-skill', 'notes.txt'))).toBe(true)
    expect(fs.existsSync(path.join(workspace, '.agents', 'skills', 'custom-skill', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(workspace, '.agents', 'skills', 'custom-skill', 'notes.txt'))).toBe(true)
  })

  it('does not rewrite Codex skill root when it already exists', async () => {
    const { ensureBuiltinAgentRuntimeSkillRoots } = await loadProvisioner()
    writeFile(path.join(workspace, '.claude', 'skills', 'source', 'SKILL.md'), '# Source')
    writeFile(path.join(workspace, '.agents', 'skills', 'existing', 'SKILL.md'), '# Existing')

    const changed = ensureBuiltinAgentRuntimeSkillRoots(workspace)

    expect(changed).toBe(false)
    expect(fs.existsSync(path.join(workspace, '.agents', 'skills', 'existing', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(workspace, '.agents', 'skills', 'source', 'SKILL.md'))).toBe(false)
  })
})
