import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
const { copyDshPreviewRuntime, prepareDshPreviewRuntime } = require_('../dsh-runtime-packaging')

it('packages only pinned DSH bootstrap resources, excluding the installed dependency tree', () => {
  const prepared = prepareDshPreviewRuntime()
  expect(prepared.bytes).toBeLessThan(1024 * 1024)
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-dsh-package-test-'))
  const resolved = path.resolve(parent)
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith('zen-dsh-package-test-')
  ) {
    throw new Error('Invalid temporary package test directory')
  }
  try {
    const target = copyDshPreviewRuntime({ appOutDir: parent, packager: { getResourcesDir: (value: string) => value } })
    expect(fs.readdirSync(target).sort()).toEqual([
      'bootstrap.json',
      'bridge.mjs',
      'node.json',
      'package-lock.json',
      'package.json'
    ])
    expect(fs.existsSync(path.join(target, 'node_modules'))).toBe(false)
    const buildConfig = fs.readFileSync(path.resolve(__dirname, '../../electron-builder.yml'), 'utf8')
    expect(buildConfig).toContain('!resources/dsh-runtime/**')
  } finally {
    fs.rmSync(resolved, { recursive: true, force: true })
  }
})
