/** Test-only: real product renderer/preload + ASAR + isolated data. Never enables production trust. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import archiver from 'archiver'

import { APP_DB_NAME } from '../../packages/shared/config/constant'
import { type HotpatchArtifact, type HotpatchBase, type HotpatchPolicy } from '../../packages/shared/hotpatch'
import { SnapshotRepository } from '../../src/main/services/hotpatch/repository'
import { HotpatchStateStore } from '../../src/main/services/hotpatch/state'
import { sha256 } from '../../src/main/services/hotpatch/verification'
import { offlineEnvironment } from '../quality/process'
import { inventory } from './base'
import { signPayload } from './sign'

async function probe(page: Page, write = false) {
  return page.evaluate(
    async ({ name, write }) => {
      const w = window as any
      if (write) {
        localStorage.setItem('hotpatch-product-smoke', 'existing-user-marker')
        w.store.dispatch({ type: 'settings/setConversationFontSize', payload: 17 })
      }
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(name)
        open.onsuccess = () => resolve(open.result)
        open.onerror = () => reject(open.error)
      })
      const marker = await new Promise<unknown>((resolve, reject) => {
        const tx = db.transaction(['settings', 'topics'], write ? 'readwrite' : 'readonly')
        if (write) {
          tx.objectStore('settings').put({ id: 'hotpatch-test-setting', value: 'existing-setting' })
          tx.objectStore('topics').put({ id: 'hotpatch-test-topic', messages: [], name: 'existing-history' })
        }
        const setting = tx.objectStore('settings').get('hotpatch-test-setting')
        const topic = tx.objectStore('topics').get('hotpatch-test-topic')
        tx.oncomplete = () => resolve({ setting: setting.result?.value, history: topic.result?.name })
        tx.onerror = () => reject(tx.error)
      })
      db.close()
      return {
        marker,
        local: localStorage.getItem('hotpatch-product-smoke'),
        font: w.store.getState().settings.conversationFontSize
      }
    },
    { name: APP_DB_NAME, write }
  )
}

async function main() {
  const root = process.cwd()
  await mkdir(path.join(root, 'local'), { recursive: true })
  const work = await mkdtemp(path.join(root, 'local/hotpatch-product-'))
  process.stdout.write(`Isolated product proof: ${work}\n`)
  const pair = generateKeyPairSync('ed25519')
  const keyId = 'isolated-product-proof-only'
  const trust = { [keyId]: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }
  const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  process.env.NODE_ENV = 'production'
  const mainOut = path.join(work, 'bundle/out/main')
  // Only the isolated test build gets its ephemeral public trust root. No production file is edited.
  const configFile = path.join(work, 'electron.config.mjs')
  const injected = `export const HOTPATCH_PRODUCTION_ENABLED=true;export const HOTPATCH_PRODUCTION_TRUST=${JSON.stringify(trust)};export const HOTPATCH_POLICY_URL='https://zenai.925636.xyz/api/client/patch-policy';export const HOTPATCH_DOWNLOAD_PREFIX='https://download.925636.xyz/zen-ai/hotpatch/';`
  await writeFile(
    configFile,
    `import original from ${JSON.stringify(path.join(root, 'electron.vite.config.ts').replaceAll('\\', '/'))};
    export default {main:{...original.main,plugins:[{name:'isolated-hotpatch-trust',enforce:'pre',
    load(id){if(id.replaceAll('\\\\','/').endsWith('/services/hotpatch/trust.ts'))return ${JSON.stringify(injected)};return null}},...(original.main.plugins||[]).filter(p=>!['zen-bundled-image-canvas','cherry-build-proxy-bootstrap'].includes(p.name))],build:{...original.main.build,outDir:${JSON.stringify(mainOut)}}}};`
  )
  // Match the production CLI process, without this test runner's tsx alias/transform hooks.
  const buildEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' }
  delete buildEnv.NODE_OPTIONS
  execFileSync(
    process.execPath,
    [path.join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'build', '--config', configFile],
    {
      cwd: root,
      env: buildEnv,
      stdio: 'inherit',
      windowsHide: true,
      timeout: 180000
    }
  )
  await cp(path.join(root, 'out/renderer'), path.join(work, 'bundle/out/renderer'), { recursive: true })
  await cp(path.join(root, 'out/preload'), path.join(work, 'bundle/out/preload'), { recursive: true })
  await cp(path.join(root, 'out/proxy'), path.join(work, 'bundle/out/proxy'), { recursive: true })
  const builtin = await inventory(path.join(work, 'bundle/out/renderer'))
  const fingerprint = sha256(JSON.stringify(builtin))
  const base: HotpatchBase = {
    appId: 'com.z685675.ZenAI',
    version: packageJson.version,
    baseBuildId: sha256(keyId + trust[keyId]),
    baseCommit: '1'.repeat(40),
    platform: process.platform as HotpatchBase['platform'],
    arch: process.arch as HotpatchBase['arch'],
    channel: 'stable',
    packaging: 'installed',
    mainFingerprint: sha256(JSON.stringify(await inventory(mainOut))),
    preloadFingerprint: sha256(JSON.stringify(await inventory(path.join(work, 'bundle/out/preload')))),
    runtimeFingerprint: fingerprint,
    contractsFingerprint: fingerprint,
    securityFingerprint: fingerprint
  }
  await writeFile(
    path.join(mainOut, 'hotpatch-base.json'),
    JSON.stringify({ schemaVersion: 1, bases: [base], builtin, frozenSources: {}, sourceClean: true })
  )
  await writeFile(
    path.join(work, 'bundle/package.json'),
    JSON.stringify({ name: 'isolated-hotpatch-product', version: packageJson.version, main: 'out/main/index.js' })
  )
  const require = createRequire(path.join(root, 'package.json'))
  const builder = createRequire(createRequire(require.resolve('electron-builder')).resolve('app-builder-lib'))
  const asar = builder('@electron/asar') as { createPackage(source: string, destination: string): Promise<void> }
  const archive = path.join(work, 'app.asar')
  await asar.createPackage(path.join(work, 'bundle'), archive)
  const immutable = sha256(await readFile(archive))
  const instance = path.join(work, 'instance')
  await mkdir(instance)
  await writeFile(path.join(instance, '.quality-instance'), 'zen-quality-isolated-v1')
  const env = offlineEnvironment(process.env)
  for (const key of [
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'XDG_DATA_HOME',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME'
  ]) {
    env[key] = path.join(instance, key)
    await mkdir(env[key], { recursive: true })
  }
  delete env.QUALITY_OFFLINE
  env.NODE_ENV = 'test'
  env.ZEN_QUALITY_INSTANCE = instance
  env.ZEN_QUALITY_PROJECT = root
  const template = await readFile(path.join(root, 'scripts/quality/electron-entry.cjs'), 'utf8')
  const entry = path.join(work, 'entry.cjs')
  const anchor = "require(path.join(project, 'out/main/index.js'))"
  assert(template.includes(anchor))
  const bootstrap = `Object.defineProperty(app,'isPackaged',{get:()=>true});app.on('session-created',s=>s.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!local(details.url)})));require(${JSON.stringify(archive + '/out/main/index.js')})`
  await writeFile(entry, template.replace(anchor, bootstrap))
  const evidence: unknown[] = []
  const closeProduct = async (application: ElectronApplication) => {
    const actual = await application.evaluate(({ app }) => app.getPath('userData'))
    assert.equal(path.resolve(actual), path.resolve(instance, 'userData'))
    const child = application.process()
    // This proof never starts tasks; unlike the release quality helper it uses an ASAR entry URL.
    await application.close()
    if (child.exitCode === null)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Isolated product did not exit normally')), 15000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    assert.equal(child.exitCode, 0, 'Isolated product crashed during shutdown')
  }
  const start = async (expected: 'builtin' | 'active') => {
    const application = await _electron.launch({
      args: [entry],
      cwd: root,
      env: env as Record<string, string>,
      timeout: 60000
    })
    try {
      const actual = await application.evaluate(({ app }) => app.getPath('userData'))
      assert.equal(path.resolve(actual), path.resolve(instance, 'userData'))
      const page = await application.firstWindow({ timeout: 60000 })
      await page.waitForFunction(() => Boolean((window as any).store?.getState?.()._persist?.rehydrated), undefined, {
        timeout: 90000
      })
      // Poll the resolved IPC value, not the truthiness of a Promise inside a DOM predicate.
      let status = await page.evaluate(() => (window as any).api.hotpatch.status())
      const expectedStartup = expected === 'active' ? 'healthy' : 'builtin'
      const deadline = Date.now() + 125000
      while (
        (!status.enabled || status.status !== expected || status.startup !== expectedStartup) &&
        Date.now() < deadline
      ) {
        await page.waitForTimeout(100)
        status = await page.evaluate(() => (window as any).api.hotpatch.status())
      }
      assert.equal(status.enabled, true)
      assert.equal(status.status, expected)
      assert.equal(status.startup, expectedStartup, 'Product did not acknowledge successful startup')
      assert.equal(await page.locator('meta[name="zen-hotpatch-product-proof"]').count(), expected === 'active' ? 1 : 0)
      evidence.push({ expected, status, url: page.url() })
      return { application, page }
    } catch (error) {
      await application.close().catch(() => {})
      throw error
    }
  }
  let running: Awaited<ReturnType<typeof start>> | undefined
  try {
    running = await start('builtin')
    const expected = await probe(running.page, true)
    await running.page.waitForTimeout(1200) // PersistRedux flush, not a model wait.
    await closeProduct(running.application)
    running = undefined
    const storage = path.join(instance, 'userData/hotpatch', base.baseBuildId)
    const store = await HotpatchStateStore.load(storage, base.baseBuildId)
    const html = await readFile(path.join(work, 'bundle/out/renderer/index.html'), 'utf8')
    const changed = html.replace('</head>', '<meta name="zen-hotpatch-product-proof" content="patch"></head>')
    assert.notEqual(html, changed)
    const files = builtin.map((file) =>
      file.path === 'index.html' ? { ...file, size: Buffer.byteLength(changed), sha256: sha256(changed) } : file
    )
    const zipFile = path.join(work, 'snapshot.zip'),
      output = createWriteStream(zipFile),
      zip = archiver('zip')
    const completed = new Promise<void>((resolve, reject) => {
      output.on('close', resolve)
      output.on('error', reject)
      zip.on('error', reject)
    })
    zip.pipe(output)
    for (const file of files) {
      if (file.path === 'index.html') zip.append(changed, { name: file.path })
      else zip.file(path.join(work, 'bundle/out/renderer', file.path), { name: file.path })
    }
    await zip.finalize()
    await completed
    const zipBytes = await readFile(zipFile)
    const artifact: HotpatchArtifact = {
      schemaVersion: 1,
      patchId: 'product-proof.1',
      base,
      sourceCommit: '2'.repeat(40),
      createdAt: Math.floor(Date.now() / 1000),
      notes: 'Isolated test only',
      archive: {
        url: 'https://download.925636.xyz/zen-ai/hotpatch/proof.zip',
        size: zipBytes.length,
        sha256: sha256(zipBytes)
      },
      expandedSize: files.reduce((sum, file) => sum + file.size, 0),
      files
    }
    const metadata = signPayload(
      'artifact',
      Buffer.from(JSON.stringify(artifact)).toString('base64url'),
      keyId,
      pem,
      trust
    )
    const policy: HotpatchPolicy = {
      schemaVersion: 1,
      base,
      policySequence: 1,
      issuedAt: Math.floor(Date.now() / 1000) - 1,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      action: 'offer',
      target: {
        patchId: artifact.patchId,
        manifestSha256: sha256(metadata),
        manifestUrl: 'https://download.925636.xyz/zen-ai/hotpatch/proof.json'
      },
      rollout: { basisPoints: 10000, salt: 'proof', testCodeHashes: [] }
    }
    const repository = new SnapshotRepository({
      root: path.join(storage, 'snapshots'),
      base,
      builtin,
      trust,
      allowed: ['https://download.925636.xyz/zen-ai/hotpatch/'],
      fetcher: async (url) => new Response(new Uint8Array(url.endsWith('.zip') ? zipBytes : metadata))
    })
    await repository.install(policy.target!, new AbortController().signal)
    const stage = async () => {
      const bytes = signPayload('policy', Buffer.from(JSON.stringify(policy)).toString('base64url'), keyId, pem, trust)
      await store.acceptPolicy(policy, bytes)
      await store.stage(policy, bytes)
    }
    await stage()
    running = await start('active')
    assert.deepEqual(await probe(running.page), expected)
    await closeProduct(running.application)
    running = undefined
    // Re-read current state: the product has now recorded its healthy startup.
    const current = await HotpatchStateStore.load(storage, base.baseBuildId)
    const rollback = { ...policy, policySequence: 2, action: 'rollback' as const, target: null }
    const rollbackBytes = signPayload(
      'policy',
      Buffer.from(JSON.stringify(rollback)).toString('base64url'),
      keyId,
      pem,
      trust
    )
    await current.acceptPolicy(rollback, rollbackBytes)
    await current.stage(rollback, rollbackBytes)
    running = await start('builtin')
    assert.deepEqual(await probe(running.page), expected)
    await closeProduct(running.application)
    running = undefined
    // A downloaded directory remains untrusted between launches, even after a healthy startup.
    const next = await HotpatchStateStore.load(storage, base.baseBuildId)
    policy.policySequence = 3
    const nextBytes = signPayload(
      'policy',
      Buffer.from(JSON.stringify(policy)).toString('base64url'),
      keyId,
      pem,
      trust
    )
    await next.acceptPolicy(policy, nextBytes)
    await next.stage(policy, nextBytes)
    const installed = await repository.load(policy.target!)
    await writeFile(path.join(installed.root, 'index.html'), changed + '<!-- tampered after download -->')
    running = await start('builtin')
    assert.deepEqual(await probe(running.page), expected)
    await closeProduct(running.application)
    running = undefined
    const recovered = await HotpatchStateStore.load(storage, base.baseBuildId)
    assert(recovered.snapshot.quarantined.some((item) => item.target.patchId === artifact.patchId))
    assert.equal(sha256(await readFile(archive)), immutable, 'Immutable ASAR changed')
    await writeFile(
      path.join(work, 'proof.json'),
      JSON.stringify(
        { passed: true, evidence, asarUnchanged: true, existingDataPreserved: true, tamperFallback: true },
        null,
        2
      )
    )
    process.stdout.write(
      'PASS: real product ASAR renderer/preload, signed snapshot, next-process activation, startup health, existing Redux/IndexedDB/localStorage, rollback, immutable ASAR.\n'
    )
  } finally {
    if (running) await running.application.close().catch(() => {})
  }
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
