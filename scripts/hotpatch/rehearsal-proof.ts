/** Exercise the actual packaged executable through the real HTTPS + IPC path. No production traffic. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

import { _electron, type ElectronApplication, type Page } from '@playwright/test'

import { APP_DB_NAME } from '../../packages/shared/config/constant'
import type { HotpatchStatus } from '../../packages/shared/hotpatch'
import { offlineEnvironment } from '../quality/process'

async function fingerprint(filename: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

async function dataMarker(page: Page, write = false) {
  return page.evaluate(
    async ({ name, write }) => {
      const w = window as any
      if (write) {
        localStorage.setItem('patch-acceptance', 'existing-local')
        w.store.dispatch({ type: 'settings/setConversationFontSize', payload: 17 })
      }
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const marker = await new Promise<unknown>((resolve, reject) => {
        const tx = db.transaction(['settings', 'topics'], write ? 'readwrite' : 'readonly')
        if (write) {
          tx.objectStore('settings').put({ id: 'acceptance-setting', value: 'existing-setting' })
          tx.objectStore('topics').put({ id: 'acceptance-topic', messages: [], name: 'existing-history' })
        }
        const setting = tx.objectStore('settings').get('acceptance-setting')
        const topic = tx.objectStore('topics').get('acceptance-topic')
        tx.oncomplete = () => resolve({ setting: setting.result?.value, history: topic.result?.name })
        tx.onerror = () => reject(tx.error)
      })
      db.close()
      return {
        marker,
        local: localStorage.getItem('patch-acceptance'),
        font: w.store.getState().settings.conversationFontSize
      }
    },
    { name: APP_DB_NAME, write }
  )
}

async function main() {
  const kitArg = process.argv[2]
  if (!kitArg) throw new Error('Pass the generated acceptance kit directory')
  const kit = path.resolve(kitArg)
  const config = JSON.parse(await readFile(path.join(kit, 'operator/config.json'), 'utf8'))
  assert.equal(config.format, 'zen-local-patch-acceptance-v1')
  const executable = path.join(kit, config.executable)
  const archive = path.join(path.dirname(executable), 'resources/app.asar')
  const immutable = await fingerprint(archive)
  const control = (command: string) =>
    execFileSync(process.execPath, [path.join(kit, 'control.cjs'), command], {
      windowsHide: true,
      stdio: 'pipe',
      timeout: 15000
    })
  const env = offlineEnvironment(process.env)
  delete env.QUALITY_OFFLINE
  delete env.ELECTRON_RUN_AS_NODE
  env.NODE_ENV = 'production'
  const require = createRequire(path.join(process.cwd(), 'package.json'))
  const builderRequire = createRequire(createRequire(require.resolve('electron-builder')).resolve('app-builder-lib'))
  const asar = builderRequire('@electron/asar') as { extractFile(archive: string, filename: string): Buffer }
  const isolatedEntry = asar.extractFile(archive, path.join('out', 'hotpatch-acceptance', 'entry.cjs')).toString('utf8')
  assert(isolatedEntry.includes('--zen-acceptance-automated-proof'), 'Missing isolated automated-test profile')
  const expectedProfile = path.resolve(process.env.APPDATA!, `${config.profileName}-proof`)
  const evidence: unknown[] = []
  let running: { application: ElectronApplication; page: Page } | undefined
  const status = (page: Page) => page.evaluate(() => (window as any).api.hotpatch.status() as Promise<HotpatchStatus>)
  const check = (page: Page, code?: string) =>
    page.evaluate((value) => (window as any).api.hotpatch.check(value) as Promise<HotpatchStatus>, code)
  const close = async () => {
    if (!running) return
    const application = running.application
    const child = application.process()
    await application.close()
    if (child.exitCode === null)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Packaged test client did not exit normally')), 20000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    assert.equal(child.exitCode, 0)
    running = undefined
  }
  const start = async (expected: HotpatchStatus['status']) => {
    process.stdout.write(`Verify packaged startup: ${expected}\n`)
    const application = await _electron.launch({
      executablePath: executable,
      args: ['--zen-acceptance-automated-proof'],
      env: env as Record<string, string>,
      timeout: 60000
    })
    try {
      assert.equal(await application.evaluate(({ app }) => app.isPackaged), true)
      assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), expectedProfile)
      const page = await application.firstWindow({ timeout: 60000 })
      running = { application, page }
      await page.waitForFunction(() => Boolean((window as any).store?.getState?.()._persist?.rehydrated), undefined, {
        timeout: 90000
      })
      const deadline = Date.now() + 125000
      let current = await status(page)
      while (
        (current.status !== expected || (expected === 'active' && current.startup !== 'healthy')) &&
        Date.now() < deadline
      ) {
        await page.waitForTimeout(200)
        current = await status(page)
      }
      assert.equal(current.enabled, true)
      assert.equal(current.status, expected, JSON.stringify(current))
      assert.equal(await page.locator('#zen-patch-acceptance').count(), expected === 'active' ? 1 : 0)
      evidence.push({ expected, status: current, packaged: true, url: page.url() })
      return page
    } catch (error) {
      await application.close().catch(() => {})
      running = undefined
      throw error
    }
  }
  try {
    control('offer')
    let page = await start('builtin')
    const expectedData = await dataMarker(page, true)
    await page.waitForTimeout(1200)
    assert.equal((await check(page)).pendingPatchId, undefined, '0% offer reached a client without a test code')
    assert.equal((await check(page, 'wrong-code')).pendingPatchId, undefined)
    const pending = await check(page, config.testCode)
    assert.equal(pending.status, 'pending', JSON.stringify(pending))
    assert.equal(pending.pendingPatchId, config.target.patchId)
    assert.equal(await page.locator('#zen-patch-acceptance').count(), 0, 'Running renderer changed without restart')
    await close()
    page = await start('active')
    assert.deepEqual(await dataMarker(page), expectedData)
    await page.screenshot({ path: path.join(kit, '补丁生效.png') })
    control('pause')
    assert.equal((await check(page)).status, 'active', 'Server pause withdrew an already healthy patch')
    await close()
    page = await start('active')
    assert.deepEqual(await dataMarker(page), expectedData)
    const disabled = await page.evaluate(() => (window as any).api.hotpatch.disable())
    assert.equal(disabled.status, 'disabled')
    await close()
    page = await start('disabled')
    assert.deepEqual(await dataMarker(page), expectedData)
    await page.evaluate(() => (window as any).api.hotpatch.enable())
    control('offer')
    assert.equal((await check(page, config.testCode)).status, 'pending')
    await close()
    page = await start('active')
    control('stop')
    await close()
    page = await start('active')
    assert.deepEqual(await dataMarker(page), expectedData)
    control('bad-signature')
    const rejected = await check(page, config.testCode)
    assert.equal(rejected.status, 'active')
    assert.equal(rejected.lastError?.code, 'signature')
    control('rollback')
    assert.equal((await check(page)).pendingPatchId, 'builtin')
    assert.equal(await page.locator('#zen-patch-acceptance').count(), 1)
    await close()
    page = await start('builtin')
    assert.deepEqual(await dataMarker(page), expectedData)
    await page.screenshot({ path: path.join(kit, '回滚完成.png') })
    control('offer')
    assert.equal((await check(page, config.testCode)).status, 'pending')
    await close()
    const cachedHtml = path.join(
      expectedProfile,
      'hotpatch',
      config.base.baseBuildId,
      'snapshots',
      `${config.target.patchId}-${config.target.manifestSha256}`,
      'files/index.html'
    )
    const originalHtml = await readFile(cachedHtml)
    await writeFile(cachedHtml, Buffer.concat([originalHtml, Buffer.from('<!-- local corruption probe -->')]))
    page = await start('builtin')
    assert.deepEqual(await dataMarker(page), expectedData)
    await close()
    assert.equal(await fingerprint(archive), immutable, 'Installed ASAR was modified')
    const state = JSON.parse(
      await readFile(path.join(expectedProfile, 'hotpatch', config.base.baseBuildId, 'state.json'), 'utf8')
    )
    assert(state.quarantined.some((item: any) => item.target.patchId === config.target.patchId))
    const proof = {
      passed: true,
      evidence,
      actualPackagedExecutable: true,
      realPinnedHttps: true,
      noCodeExcluded: true,
      nextProcessActivation: true,
      existingDataPreserved: true,
      pausePreservesActive: true,
      optOutAndResume: true,
      offlineHealthyStartup: true,
      invalidSignatureRejected: true,
      rollback: true,
      tamperFallback: true,
      asarUnchanged: true
    }
    await writeFile(path.join(kit, 'proof.json'), JSON.stringify(proof, null, 2))
    process.stdout.write(
      'PASS: packaged executable, real HTTPS, 0% test rollout, next-start activation, data preservation, pause/resume, offline, signature rejection, rollback, corruption recovery, immutable ASAR.\n'
    )
  } finally {
    await close().catch(() => {})
    control('rollback')
    control('stop')
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
