/** Build a local-only Windows acceptance kit. Production trust and services are never changed. */
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes, X509Certificate } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import path from 'node:path'

import archiver from 'archiver'
import type * as Builder from 'electron-builder'
import type * as Yaml from 'yaml'

import {
  HOTPATCH_APP_ID,
  HOTPATCH_FORMAT,
  type HotpatchArtifact,
  type HotpatchBase
} from '../../packages/shared/hotpatch'
import { hotpatchDescriptorSchema } from '../../packages/shared/hotpatchBuild'
import { sha256, validateArtifact, verifyEnvelope } from '../../src/main/services/hotpatch/verification'
import { inventory } from './base'
import { signPayload } from './sign'

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback address')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This acceptance kit targets Windows x64')
  const root = process.cwd()
  await mkdir(path.join(root, 'local'), { recursive: true })
  const kit = await mkdtemp(path.join(root, 'local/hotpatch-acceptance-'))
  process.stdout.write(`Acceptance kit: ${kit}\n`)
  const operator = path.join(kit, 'operator')
  await mkdir(operator)
  const owner = execFileSync('whoami.exe', [], { encoding: 'utf8', windowsHide: true }).trim()
  execFileSync('icacls.exe', [operator, '/inheritance:r', '/grant:r', `${owner}:(OI)(CI)F`], {
    windowsHide: true,
    stdio: 'pipe'
  })
  const pair = generateKeyPairSync('ed25519')
  const keyId = `local-acceptance-${randomBytes(6).toString('hex')}`
  const trust = { [keyId]: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }
  const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  await writeFile(path.join(operator, 'signing-key.pem'), privatePem, { flag: 'wx', mode: 0o600 })
  await writeFile(path.join(kit, 'public-key.pem'), trust[keyId], { flag: 'wx' })
  // A pinned local certificate is trusted only by the isolated patch-download partition.
  const openssl = path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/usr/bin/openssl.exe')
  execFileSync(
    openssl,
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      path.join(operator, 'tls-key.pem'),
      '-out',
      path.join(operator, 'tls-cert.pem'),
      '-days',
      '30',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1'
    ],
    { windowsHide: true, stdio: 'pipe' }
  )
  const certificate = new X509Certificate(await readFile(path.join(operator, 'tls-cert.pem')))
  const port = await availablePort()
  const origin = `https://127.0.0.1:${port}`
  const policyUrl = `${origin}/policy`
  const prefix = `${origin}/patches/`
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const rehearsalOut = path.join(root, 'out/hotpatch-acceptance')
  const mainOut = path.join(rehearsalOut, 'main')
  await mkdir(mainOut, { recursive: true })
  const publicConfig = `export const HOTPATCH_PRODUCTION_ENABLED=true;export const HOTPATCH_PRODUCTION_TRUST=${JSON.stringify(trust)};export const HOTPATCH_POLICY_URL=${JSON.stringify(policyUrl)};export const HOTPATCH_DOWNLOAD_PREFIX=${JSON.stringify(prefix)};`
  const configFile = path.join(kit, 'electron.config.mjs')
  await writeFile(
    configFile,
    `import original from ${JSON.stringify(path.join(root, 'electron.vite.config.ts').replaceAll('\\', '/'))};
    export default {main:{...original.main,plugins:[{name:'local-acceptance-only',enforce:'pre',load(id){
    const name=id.replaceAll('\\\\','/');
    if(name.endsWith('/services/hotpatch/trust.ts'))return ${JSON.stringify(publicConfig)};
    if(name.endsWith('/main/utils/init.ts'))return 'export function initAppDataDir(){};export function updateAppDataConfig(){}';
    return null}},...(original.main.plugins||[]).filter(p=>!['zen-bundled-image-canvas','cherry-build-proxy-bootstrap'].includes(p.name))],
    build:{...original.main.build,outDir:${JSON.stringify(mainOut)}}}};`
  )
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
  for (const directory of ['renderer', 'preload', 'proxy'])
    await cp(path.join(root, 'out', directory), path.join(rehearsalOut, directory), { recursive: true })
  const builtin = await inventory(path.join(rehearsalOut, 'renderer'))
  const fingerprint = sha256(JSON.stringify(builtin))
  const base: HotpatchBase = {
    appId: HOTPATCH_APP_ID,
    version: pkg.version,
    baseBuildId: sha256(keyId + trust[keyId] + fingerprint),
    baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
    platform: 'win32',
    arch: 'x64',
    channel: 'local-acceptance-only',
    packaging: 'installed',
    mainFingerprint: sha256(JSON.stringify(await inventory(mainOut))),
    preloadFingerprint: sha256(JSON.stringify(await inventory(path.join(rehearsalOut, 'preload')))),
    runtimeFingerprint: sha256(await readFile(path.join(root, 'pnpm-lock.yaml'))),
    contractsFingerprint: fingerprint,
    securityFingerprint: sha256(trust[keyId])
  }
  // Synthetic test identity, as in product-smoke.ts. It is never eligible for production publication.
  const descriptor = hotpatchDescriptorSchema.parse({
    schemaVersion: 1,
    bases: [base],
    builtin,
    frozenSources: {},
    sourceClean: true
  })
  await writeFile(path.join(mainOut, 'hotpatch-base.json'), JSON.stringify(descriptor))
  const profileName = `ZenAIPatchAcceptance/${base.baseBuildId.slice(0, 12)}`
  const entry = `const {app,session}=require('electron');const fs=require('node:fs');const path=require('node:path');const {X509Certificate}=require('node:crypto');
    app.setName('Zen AI Patch Test');
    const profile=path.join(app.getPath('appData'),${JSON.stringify(profileName)}+(process.argv.includes('--zen-acceptance-automated-proof')?'-proof':''));
    for(const name of ['userData','sessionData','logs']){const dir=name==='userData'?profile:path.join(profile,name);fs.mkdirSync(dir,{recursive:true});app.setPath(name,dir)}
    app.setAsDefaultProtocolClient=()=>false;app.removeAsDefaultProtocolClient=()=>false;
    delete process.env.PORTABLE_EXECUTABLE_DIR;delete process.env.PORTABLE_EXECUTABLE_FILE;
    const local=value=>{try{const u=new URL(value);return ['file:','data:','blob:','devtools:'].includes(u.protocol)||u.origin===${JSON.stringify(origin)}}catch{return false}};
    const originalFetch=global.fetch;global.fetch=(input,init)=>{const url=typeof input==='string'||input instanceof URL?String(input):input.url;if(!local(url))return Promise.reject(new Error('Acceptance build rejects external fetch'));return originalFetch(input,init)};
    app.on('session-created',s=>s.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!local(details.url)})));
    app.whenReady().then(()=>session.fromPartition('zen-hotpatch-download').setCertificateVerifyProc((request,callback)=>{let valid=false;try{valid=request.hostname==='127.0.0.1'&&new X509Certificate(request.certificate.data).fingerprint256===${JSON.stringify(certificate.fingerprint256)}}catch{}callback(valid?0:-2)}));
    require('./main/index.js');`
  await writeFile(path.join(rehearsalOut, 'entry.cjs'), entry)
  const html = await readFile(path.join(rehearsalOut, 'renderer/index.html'), 'utf8')
  const changed = html.replace(
    '</body>',
    '<aside id="zen-patch-acceptance" style="position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#237b4b;color:white;padding:6px 16px;border-radius:8px;pointer-events:none">补丁验收 A · 已生效</aside></body>'
  )
  if (html === changed) throw new Error('Cannot insert visible acceptance marker')
  const files = builtin.map((file) =>
    file.path === 'index.html' ? { ...file, size: Buffer.byteLength(changed), sha256: sha256(changed) } : file
  )
  const patchDir = path.join(kit, 'patch')
  await mkdir(patchDir)
  const archiveFile = path.join(patchDir, 'snapshot.zip')
  const output = createWriteStream(archiveFile, { flags: 'wx' })
  const zip = archiver('zip', { zlib: { level: 6 } })
  const completed = new Promise<void>((resolve, reject) => {
    output.on('close', resolve)
    output.on('error', reject)
    zip.on('error', reject)
  })
  zip.pipe(output)
  for (const file of files) {
    if (file.path === 'index.html') zip.append(changed, { name: file.path })
    else zip.file(path.join(rehearsalOut, 'renderer', file.path), { name: file.path })
  }
  await zip.finalize()
  await completed
  const zipBytes = await readFile(archiveFile)
  const artifact: HotpatchArtifact = {
    schemaVersion: 1,
    patchId: 'acceptance.a',
    base,
    sourceCommit: base.baseCommit,
    createdAt: Math.floor(Date.now() / 1000),
    notes: 'Local acceptance only: visible UI marker; no production rollout.',
    archive: { url: `${prefix}snapshot.zip`, sha256: sha256(zipBytes), size: zipBytes.length },
    expandedSize: files.reduce((total, file) => total + file.size, 0),
    files
  }
  validateArtifact(artifact, base, builtin)
  const manifest = signPayload(
    'artifact',
    Buffer.from(JSON.stringify(artifact)).toString('base64url'),
    keyId,
    privatePem,
    trust
  )
  verifyEnvelope(manifest, 'artifact', trust)
  await writeFile(path.join(patchDir, 'manifest.json'), manifest, { flag: 'wx' })
  const config = {
    format: 'zen-local-patch-acceptance-v1',
    envelopeFormat: HOTPATCH_FORMAT,
    base,
    keyId,
    origin,
    port,
    testCode: `ZEN-TEST-${randomBytes(4).toString('hex').toUpperCase()}`,
    controlToken: randomBytes(32).toString('hex'),
    profileName,
    executable: 'build/win-unpacked/Zen AI Patch Test.exe',
    target: { patchId: artifact.patchId, manifestUrl: `${prefix}manifest.json`, manifestSha256: sha256(manifest) }
  }
  await writeFile(path.join(operator, 'config.json'), JSON.stringify(config, null, 2))
  await cp(path.join(root, 'scripts/hotpatch/fixtures/rehearsal-control.cjs'), path.join(kit, 'control.cjs'))
  for (const [filename, command] of [
    ['01-启动测试.cmd', 'start'],
    ['02-投放补丁A.cmd', 'offer'],
    ['03-回滚到原界面.cmd', 'rollback'],
    ['04-暂停新投放.cmd', 'pause'],
    ['05-停止本地投放服务.cmd', 'stop'],
    ['06-测试错误签名.cmd', 'bad-signature']
  ]) {
    await writeFile(
      path.join(kit, filename),
      `@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%~dp0build\\win-unpacked\\Zen AI Patch Test.exe" "%~dp0control.cjs" ${command}\r\nif errorlevel 1 pause\r\nendlocal\r\n`
    )
  }
  const instructions = `# Zen AI 补丁本机验收\n\n这是当前工作代码制作的独立 Windows x64 测试包，版本 ${pkg.version}。与日常版本使用不同的数据目录，不连接生产投放服务。\n\n## 开始测试\n\n1. 双击「01-启动测试.cmd」，启动本地 HTTPS 投放服务和测试版软件。无需先安装；也可使用 build 中的 setup.exe 单独安装测试版。\n2. 打开「设置 → 关于 → 界面补丁」，应显示「内置界面」。可先在测试版新建一条对话或修改字体，留作数据保留检查。\n3. 双击「02-投放补丁A.cmd」。不填投放码时检查补丁，不应收到补丁。\n4. 填写测试投放码 **${config.testCode}**，点击「检查补丁」。应显示等待下次启动；当前界面不会立刻改变。\n5. 从托盘菜单完全退出测试版，再双击「01-启动测试.cmd」。应显示「补丁已应用」，顶部出现绿色「补丁验收 A · 已生效」。原对话和设置应保留。\n6. 双击「05-停止本地投放服务.cmd」，退出再开测试版的 exe（不要运行 01，否则会重启服务），已经验证成功的补丁应仍可用。\n7. 双击「03-回滚到原界面.cmd」，在测试版点击检查补丁，完全退出后重新打开。绿色标记应消失，对话和设置保留。\n\n## 补充验收\n\n- 客户端「暂停补丁」：确认后完全退出，下次启动使用内置界面；恢复后可再次填写投放码检查。\n- 「04-暂停新投放.cmd」只暂停新启用，不撤回已经应用成功的补丁；回退用 03。\n- 「06-测试错误签名.cmd」后检查补丁，应出现 signature 错误，并继续使用当前可用界面。重新运行 02 会签发新的有效策略。\n- 如界面无法启动：运行测试 exe 时追加 --zen-safe-mode，可回到内置界面。\n\n## 范围和文件\n\n- 仅本机 127.0.0.1 HTTPS；证书只在测试版补丁下载会话中固定信任，不安装系统证书。\n- 测试投放为 0%，只有测试投放码可以接收。策略有效期 6 天，重新运行 02/03/04 会生成更高序号的新策略。\n- 这是本地合成基础身份，只验证客户端真实打包、HTTPS 下载、签名、重启应用和回退；不代替 GitHub 签名、生产 API 面板和 CDN 的联网验收。\n- 测试数据：%APPDATA%\\${profileName.replaceAll('/', '\\')}。正常版本的数据不会迁入此处。\n- operator 目录保存本次测试的私钥和本地服务配置，已限制为当前 Windows 账号访问。私钥未放入安装包。不要把整套目录作为正式安装包分发。\n- requests.jsonl 和 server.log 是本地投放日志；自动验收结果保存为 proof.json（执行自动验收后）。\n- 测试完成后运行 05，完全退出测试软件即可停止。\n`
  await writeFile(path.join(kit, '开始测试.md'), instructions)
  await writeFile(
    path.join(kit, 'provenance.json'),
    JSON.stringify(
      {
        testOnly: true,
        productionTrustChanged: false,
        workingTreeClean: false,
        sourceCommit: base.baseCommit,
        rendererFingerprint: fingerprint,
        descriptor
      },
      null,
      2
    )
  )
  const require = createRequire(path.join(root, 'package.json'))
  const { parse } = require('yaml') as typeof Yaml
  const builder = require('electron-builder') as typeof Builder
  const builderConfig = parse(await readFile(path.join(root, 'electron-builder.yml'), 'utf8'))
  delete builderConfig.nsis.include // Test installer must never close or uninstall the user's normal Zen AI.
  delete builderConfig.protocols
  delete builderConfig.fileAssociations
  delete builderConfig.artifactBuildCompleted
  builderConfig.appId = 'com.z685675.ZenAIPatchAcceptance'
  builderConfig.productName = 'Zen AI Patch Test'
  builderConfig.directories.output = path.join(kit, 'build')
  builderConfig.extraMetadata = { main: 'out/hotpatch-acceptance/entry.cjs' }
  builderConfig.win.executableName = 'Zen AI Patch Test'
  builderConfig.win.signAndEditExecutable = false
  builderConfig.nsis.shortcutName = 'Zen AI Patch Test'
  builderConfig.nsis.uninstallDisplayName = 'Zen AI Patch Test'
  builderConfig.nsis.createDesktopShortcut = false
  builderConfig.nsis.artifactName = 'Zen-AI-Patch-Test-${version}-x64-setup.${ext}'
  builderConfig.publish = null
  const beforePack = path.join(kit, 'before-pack.cjs')
  await writeFile(
    beforePack,
    `exports.default=async context=>{
    await require(${JSON.stringify(path.join(root, 'scripts/before-pack.js'))}).default(context);
    context.packager.config.files[0].filter=context.packager.config.files[0].filter.filter(pattern=>pattern!=='!out/hotpatch-acceptance{,/**}');
    context.packager.config.files[0].filter.push('!out/main{,/**}','!out/preload{,/**}','!out/renderer{,/**}','!out/proxy{,/**}');
  };`
  )
  builderConfig.beforePack = beforePack
  const installerConfig = path.join(kit, 'installer.json')
  await writeFile(installerConfig, JSON.stringify(builderConfig, null, 2))
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  await builder.build({
    projectDir: root,
    targets: builder.Platform.WINDOWS.createTarget(['nsis'], builder.Arch.x64),
    config: installerConfig,
    publish: 'never'
  })
  process.stdout.write(`READY: ${kit}\nRead 开始测试.md. Production trust remains disabled.\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
