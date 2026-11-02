import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import YAML from 'yaml'

const { buildReleaseHistory } = require('../build-release-history')
const release = (tag: string, body: string, extra = {}) => ({
  tag_name: tag,
  body,
  draft: false,
  prerelease: false,
  published_at: '2026-11-01T00:00:00Z',
  ...extra
})

describe('published release history', () => {
  it('archives paginated final notes, sorts versions numerically and excludes drafts and prereleases', () => {
    const archive = buildReleaseHistory([
      [release('v1.1.9', 'old'), release('v1.1.80', 'hidden', { draft: true })],
      [
        release('v1.1.79', 'Final edited notes'),
        release('v1.1.81-beta.1', 'beta'),
        release('v1.1.78', 'unpublished', { published_at: null })
      ]
    ])
    expect(archive.entries.map((item: any) => item.version)).toEqual(['1.1.79', '1.1.9'])
    expect(archive.entries[0].notes).toBe('Final edited notes')
    expect(JSON.stringify(archive)).not.toContain('hidden')
  })

  it('publishes the history file beside update metadata using the final release body', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'zen-history-publish-'))
    try {
      const current = {
        tagName: 'v1.1.79',
        name: 'Zen AI',
        body: 'Final user-edited notes',
        publishedAt: '2026-11-01T00:00:00Z',
        isDraft: false,
        isPrerelease: false
      }
      writeFileSync(path.join(directory, 'release.json'), JSON.stringify(current))
      writeFileSync(
        path.join(directory, 'history.json'),
        JSON.stringify([[release('v1.1.77', 'Earlier notes'), release('v1.1.80', 'Draft notes', { draft: true })]])
      )
      writeFileSync(path.join(directory, 'latest.yml'), 'version: 1.1.79\nreleaseNotes: placeholder\n')
      const options = {
        cwd: directory,
        encoding: 'utf8' as const,
        windowsHide: true,
        env: {
          ...process.env,
          RELEASE_JSON_PATH: 'release.json',
          RELEASE_HISTORY_JSON_PATH: 'history.json',
          RELEASE_ASSETS_DIR: '.'
        }
      }
      const script = path.resolve('scripts/sync-release-metadata.js')
      execFileSync(process.execPath, [script], options)
      const archive = JSON.parse(readFileSync(path.join(directory, 'release-history.json'), 'utf8'))
      expect(archive.entries.map((item: any) => item.version)).toEqual(['1.1.79', '1.1.77'])
      expect(archive.entries[0].notes).toBe(current.body)
      expect(YAML.parse(readFileSync(path.join(directory, 'latest.yml'), 'utf8')).releaseNotes).toBe(current.body)

      const before = readFileSync(path.join(directory, 'latest.yml'), 'utf8')
      writeFileSync(path.join(directory, 'release.json'), JSON.stringify({ ...current, isDraft: true }))
      expect(() => execFileSync(process.execPath, [script], { ...options, stdio: 'pipe' })).toThrow()
      expect(readFileSync(path.join(directory, 'latest.yml'), 'utf8')).toBe(before)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
