import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { build } from 'vite'

import { HOTPATCH_ENTRIES } from '../../packages/shared/hotpatch'

async function main() {
  const work = await mkdtemp(resolve(tmpdir(), 'zen-hotpatch-smoke-'))
  const original = resolve(work, 'bundled-renderer')
  const snapshot = resolve(work, 'snapshot')
  await mkdir(original)
  await mkdir(snapshot)
  const html = (version: string) =>
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'"><div id="version">${version}</div><script type="module" src="./entry.js"></script>`
  const entry = `
try {
const worker = new Worker(new URL('./worker.js', import.meta.url), {type:'module'});
const workerResult = new Promise((resolve,reject) => {worker.onmessage = event => resolve(event.data);worker.onerror = event => reject(Error(event.message))});
const chunk = await import('./chunk.js');
const wasm = await WebAssembly.instantiateStreaming(fetch('./empty.wasm'));
window.smoke = { chunk:chunk.value, worker:await workerResult, wasm:!!wasm.instance, url:location.href, node:typeof require };
worker.terminate();
} catch(error) { window.smokeFailure=String(error); }
`
  const files: Record<string, string | Uint8Array> = {
    ...Object.fromEntries(HOTPATCH_ENTRIES.map((name) => [name, html('builtin')])),
    'entry.js': entry,
    'worker.js': `postMessage('worker-ok')`,
    'chunk.js': `export const value='dynamic-ok'`,
    'empty.wasm': new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])
  }
  for (const [name, bytes] of Object.entries(files)) {
    await writeFile(resolve(original, name), bytes)
    await writeFile(resolve(snapshot, name), name.endsWith('.html') ? html(`patch-${name}`) : bytes)
  }
  await writeFile(resolve(work, 'attachment.txt'), 'user-attachment-unchanged')
  await writeFile(resolve(work, 'foreign.js'), 'window.foreignExecuted=true')
  const preload = resolve(work, 'preload.cjs')
  await writeFile(
    preload,
    `const {contextBridge}=require('electron');contextBridge.exposeInMainWorld('smokeBridge',{ping:()=>true})`
  )
  const fixture = resolve(work, 'fixture.ts')
  await writeFile(
    fixture,
    `
import { app, BrowserWindow, session, net } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createSecureFileFallback, createSnapshotResourceHandler } from ${JSON.stringify(resolve('src/main/services/hotpatch/resources.ts'))}
import { HOTPATCH_CSP } from ${JSON.stringify(resolve('src/main/services/hotpatch/security.ts'))}
app.disableHardwareAcceleration()
app.on('window-all-closed',()=>{})
app.setPath('userData', ${JSON.stringify(resolve(work, 'data'))})
const original=${JSON.stringify(original)},snapshot=${JSON.stringify(snapshot)}
let errors=[]
let stage='builtin'
function check(value,message){if(!value)throw Error(message)}
async function open(name){
 const window=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(preload)},nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,backgroundThrottling:false}})
 await window.loadFile(original+'/'+name)
 const until=Date.now()+10000
 while(!(await window.webContents.executeJavaScript('!!window.smoke || !!window.smokeFailure'))&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,30))
 const state=await window.webContents.executeJavaScript('({...window.smoke,failure:window.smokeFailure,bridge:window.smokeBridge.ping(),version:document.getElementById("version").textContent})')
 check(state.chunk==='dynamic-ok'&&state.worker==='worker-ok'&&state.wasm&&state.node==='undefined'&&state.bridge,'modules/worker/wasm/preload failed: '+JSON.stringify(state))
 return window
}
async function data(window,write){return window.webContents.executeJavaScript('('+ (async(write)=>{
 if(write)localStorage.setItem('persist:cherry-studio','existing-settings')
 const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('hotpatch-origin-proof',1);request.onupgradeneeded=()=>request.result.createObjectStore('history');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})
 const result=await new Promise((resolve,reject)=>{const transaction=db.transaction('history',write?'readwrite':'readonly');const request=write?transaction.objectStore('history').put('existing-history','topic'):transaction.objectStore('history').get('topic');request.onsuccess=()=>resolve(write?'existing-history':request.result);request.onerror=()=>reject(request.error)})
 db.close();return {history:result,settings:localStorage.getItem('persist:cherry-studio')}
 }).toString()+')('+JSON.stringify(write)+')')}
app.whenReady().then(async()=>{
 try{
  let main=await open('index.html');const url=main.webContents.getURL();await data(main,true);main.destroy()
  const files=await Promise.all(${JSON.stringify(Object.keys(files))}.map(async path=>{const bytes=await readFile(snapshot+'/'+path);return {path,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}}))
  stage='patch-load'
  session.defaultSession.protocol.handle('file',createSnapshotResourceHandler({originalRoot:original,snapshotRoot:snapshot,files,securityPolicy:HOTPATCH_CSP,fallback:createSecureFileFallback(original,request=>net.fetch(request,{bypassCustomProtocolHandlers:true})),onFailure:error=>{errors.push(String(error));process.stderr.write(String(error)+'\\n')}}))
  main=await open('index.html');const others=await Promise.all(${JSON.stringify(HOTPATCH_ENTRIES.slice(1))}.map(open))
  check(main.webContents.getURL()===url,'entry URL changed')
  for(const window of [main,...others]){const state=await data(window,false);check(state.history==='existing-history'&&state.settings==='existing-settings','storage identity changed')}
  const foreign=await main.webContents.executeJavaScript('(async()=>{const script=document.createElement("script");script.src='+JSON.stringify(pathToFileURL(${JSON.stringify(resolve(work, 'foreign.js'))}).href)+';await new Promise(resolve=>{script.onload=resolve;script.onerror=resolve;document.head.appendChild(script)});return window.foreignExecuted===undefined})()')
  check(foreign,'outside-file script executed in privileged renderer')
  check(await main.webContents.executeJavaScript('document.getElementById("version").textContent === "patch-index.html"'),'patch not loaded')
  check(await (await net.fetch(pathToFileURL(${JSON.stringify(resolve(work, 'attachment.txt'))}).href)).text()==='user-attachment-unchanged','attachment intercepted')
  await writeFile(snapshot+'/chunk.js','export const value="tampered"')
  check((await net.fetch(pathToFileURL(original+'/chunk.js').href+'?tamper=1')).status===500,'tampered snapshot accepted')
  check((await net.fetch(pathToFileURL(original+'/missing.js').href)).status===500,'mixed snapshot fallback accepted')
  check(errors.length===2,'unexpected resource failures: '+errors)
  stage='rollback'
  main.destroy();others.forEach(window=>window.destroy());session.defaultSession.protocol.unhandle('file')
  main=await open('index.html');const state=await data(main,false)
  check(state.history==='existing-history'&&state.settings==='existing-settings','rollback lost user storage')
  check(await main.webContents.executeJavaScript('document.getElementById("version").textContent === "builtin"'),'rollback not builtin')
  process.stdout.write('PASS: stable file URL, existing localStorage/IndexedDB, five windows, module/worker/WASM, isolated preload, outside-file script rejected, attachment passthrough, tamper rejection, no mixed chunks, builtin rollback\\n')
  await writeFile(${JSON.stringify(resolve(work, 'proof.json'))},JSON.stringify({passed:true}))
  main.destroy();app.exit(0)
 }catch(error){process.stderr.write(stage+': '+String(error)+'\\n');app.exit(1)}
})
`
  )
  await build({
    configFile: false,
    plugins: [
      {
        name: 'hotpatch-smoke-shared',
        resolveId(id) {
          if (id === '@shared/hotpatch') return resolve('packages/shared/hotpatch.ts').replaceAll('\\', '/')
          return null
        }
      }
    ],
    build: {
      outDir: resolve(work, 'compiled'),
      lib: { entry: fixture, formats: ['cjs'], fileName: () => 'smoke.cjs' },
      minify: false,
      rollupOptions: { external: (id) => id === 'electron' || id.startsWith('node:') }
    }
  })
  const electron = (await import('electron')).default as unknown as string
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const code = await new Promise<number>((done, reject) => {
    const child = spawn(electron, [resolve(work, 'compiled/smoke.cjs')], {
      stdio: 'inherit',
      windowsHide: true,
      env: environment
    })
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('Hotpatch isolated Electron smoke timed out'))
    }, 45000)
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timeout)
      done(code ?? 1)
    })
  })
  const proof = await readFile(resolve(work, 'proof.json'), 'utf8')
    .then((value) => JSON.parse(value))
    .catch(() => null)
  const passed = code === 0 && proof?.passed === true
  await writeFile(
    resolve(work, 'result.json'),
    JSON.stringify({
      code,
      passed,
      electron: JSON.parse(await readFile(resolve('node_modules/electron/package.json'), 'utf8')).version,
      work
    })
  )
  process.stdout.write(`Isolated hotpatch smoke evidence: ${work}\n`)
  process.exitCode = passed ? 0 : 1
}

void main().catch((error) => {
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
})
