import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readlink } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import type { Inventory, Manifest, Mode, Project, Revision, Selection } from './types'

const execFileAsync = promisify(execFile)

async function git(root: string, args: string[]) {
  const result = await execFileAsync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15000,
    windowsHide: true
  })
  return result.stdout
}

export function splitPaths(output: string) {
  return [
    ...new Set(
      output
        .split('\0')
        .filter(Boolean)
        .map((file) => file.replaceAll('\\', '/'))
    )
  ].sort()
}

export async function inspectRevision(root: string, base?: string): Promise<Revision> {
  const revision: Revision = { head: null, base: null, dirty: null, changedPaths: [], changeDigest: null }
  try {
    revision.head = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim()
    const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    revision.dirty = status.length > 0
    // Includes staged/unstaged changes and both sides of renames. Never execute a user-built shell command.
    const working = await git(root, ['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--'])
    const untracked = await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    revision.changedPaths = splitPaths(working + untracked)
    const digest = createHash('sha256').update(await git(root, ['diff', '--binary', 'HEAD', '--']))
    for (const file of splitPaths(untracked)) {
      digest.update(file + '\0')
      const absolute = path.join(root, file)
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) digest.update('symlink:' + (await readlink(absolute)))
      else if (info.isFile()) for await (const chunk of createReadStream(absolute)) digest.update(chunk)
      digest.update('\0')
    }
    revision.changeDigest = digest.digest('hex')
    if (!base || base.startsWith('-') || ['\0', '\r', '\n'].some((character) => base.includes(character))) {
      revision.error = '未提供可靠的基准提交。'
      return revision
    }
    revision.base = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`])).trim()
    const committed = await git(root, ['diff', '--name-only', '--no-renames', '-z', revision.base, revision.head, '--'])
    revision.changedPaths = splitPaths(committed + working + untracked)
  } catch {
    revision.error = '无法读取仓库或基准提交。'
  }
  return revision
}

export async function inspectInventory(root: string, project: Project): Promise<Inventory> {
  try {
    const files = splitPaths(await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']))
    const packagePath = project === 'ai' ? `${root}/package.json` : `${root}/web/default/package.json`
    const pkg = JSON.parse(await readFile(packagePath, 'utf8')) as { scripts?: Record<string, string> }
    if (project === 'api') await readFile(`${root}/go.mod`, 'utf8')
    return {
      project,
      available: true,
      testFiles: files.filter((file) =>
        project === 'ai' ? /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) : file.endsWith('_test.go')
      ).length,
      scripts: Object.keys(pkg.scripts ?? {}).sort(),
      workflows: files.filter((file) => /^\.github\/workflows\/.*\.ya?ml$/.test(file)),
      limitations:
        project === 'ai'
          ? ['既有 Playwright 使用非隔离启动且 CI 默认重试2次，本批不自动运行。', '测试文件数量不是业务场景覆盖率。']
          : ['Go 测试使用自身隔离 fixture；不连接生产数据库。', '本批不验证真实 MySQL/PostgreSQL 部署。']
    }
  } catch {
    return {
      project,
      available: false,
      testFiles: 0,
      scripts: [],
      workflows: [],
      limitations: ['仓库、Git 或依赖清单不可读取，不能宣称该项目已检查。']
    }
  }
}

export function selectChecks(manifest: Manifest, project: Project, mode: Mode, revision: Revision): Selection {
  const available = manifest.checks.filter((check) => check.project === project)
  const result: Selection = { project, tags: [], reasons: [], fallbackToFull: false, checkIds: [] }
  if (mode === 'inventory' || mode === 'live') return result
  if (mode !== 'changed') {
    result.tags =
      mode === 'release'
        ? ['full']
        : [...new Set(available.filter((check) => check.modes.includes('offline')).flatMap((check) => check.tags))]
    result.reasons = [mode === 'release' ? '发版执行全量门槛，不按改动缩减。' : '执行已登记的离线关键回归。']
    result.checkIds = available.filter((check) => check.modes.includes(mode)).map((check) => check.id)
    return result
  }
  const full = (reason: string) => {
    result.fallbackToFull = true
    result.tags = ['full']
    result.reasons.push(reason)
    result.checkIds = available.filter((check) => check.modes.includes('release')).map((check) => check.id)
    return result
  }
  if (revision.error || !revision.base) return full(revision.error ?? '基准未知，执行全量。')
  if (manifest.mappingError) return full(manifest.mappingError)
  const tags = new Set<string>()
  for (const file of revision.changedPaths) {
    if (file.startsWith('docs/') || /^README(?:\.[a-z-]+)?\.md$/i.test(file) || /^(LICENSE|NOTICE)(\.|$)/.test(file))
      continue
    if (
      /^(package\.json|pnpm-lock\.yaml|bun\.lockb?|go\.(mod|sum)|[^/]*config\.[^/]+|\.github\/|packages\/shared\/(IpcChannel|types))/.test(
        file
      )
    ) {
      return full(`共享配置/依赖/工作流变化：${file}`)
    }
    const matches = manifest.rules.filter(
      (rule) => rule.project === project && rule.prefixes.some((prefix) => file.startsWith(prefix))
    )
    if (!matches.length) return full(`未建立可靠影响映射：${file}`)
    for (const match of matches) for (const tag of match.tags) tags.add(tag)
  }
  result.tags = [...tags].sort()
  result.reasons = [
    tags.size
      ? '按已登记规则选择关联回归；未映射源码会扩大为全量。'
      : '与基准一致或仅文档变更；没有自动执行的源码检查。'
  ]
  result.checkIds = available
    .filter((check) => (check.tags.includes('static') && tags.size > 0) || check.tags.some((tag) => tags.has(tag)))
    .filter((check) => !check.tags.includes('full'))
    .map((check) => check.id)
  return result
}
