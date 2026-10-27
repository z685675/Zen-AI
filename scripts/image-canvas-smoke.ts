import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { build } from 'vite'

// A real Electron smoke check with an isolated userData directory and local
// mock upstream. It never reads user providers or sends paid model requests.
async function main() {
  const workbench = true
  const benchmark = process.argv.includes('--benchmark')
  const packagedIndex = process.argv.indexOf('--packaged-app')
  const packagedApp = packagedIndex >= 0 ? process.argv[packagedIndex + 1] : undefined
  if (packagedIndex >= 0 && (!packagedApp || !packagedApp.endsWith('.asar')))
    throw new Error('--packaged-app requires the path to app.asar')
  const directory = mkdtempSync(resolve('tmp/image-canvas-smoke-'))
  const root = process.cwd()
  const data = mkdtempSync(resolve(tmpdir(), 'zen-image-canvas-smoke-'))
  writeFileSync(
    resolve(directory, 'logger.ts'),
    `export const loggerService = { withContext: () => ({ info: () => {}, warn: () => {}, error: (...args: unknown[]) => process.stderr.write(String(args[1]) + '\\n') }) }`
  )
  writeFileSync(
    resolve(directory, 'entry.ts'),
    `
import { app, BrowserWindow } from 'electron'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { ImageCanvasService } from ${JSON.stringify(resolve('src/main/services/ImageCanvasService.ts').replaceAll('\\', '/'))}
app.disableHardwareAcceleration()
app.setPath('userData', ${JSON.stringify(data)})
app.whenReady().then(async () => {
 let server
 try {
  const image = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#dce4ff"/><stop offset="1" stop-color="#f7e8dd"/></linearGradient></defs><rect width="960" height="640" fill="url(#g)"/><circle cx="690" cy="190" r="90" fill="#f8f6ef"/><path d="M0 480L260 220 510 480 690 300 960 540V640H0Z" fill="#a3b2d5"/><path d="M0 580L300 420 590 550 780 440 960 520V640H0Z" fill="#788da9"/><text x="46" y="66" font-family="Arial" font-size="24" fill="#425272">OFFLINE TEST IMAGE</text></svg>')).png().toBuffer()
  let calls=0
  server=createServer((req,res)=>{
   if(!['/v1/images/generations','/v1/images/edits'].includes(req.url) || req.headers.authorization!=='Bearer offline-test-key'){res.writeHead(400);res.end();return}
   calls++;req.resume();res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{b64_json:image.toString('base64')}]}))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const window = new BrowserWindow({show:false,width:1000,height:760,webPreferences:{sandbox:true}})
  const service = new ImageCanvasService(window)
  // The bundled service resolves these paths relative to out/main in production.
  const providers=[{id:'offline',name:'Offline smoke',apiHost:'http://127.0.0.1:'+server.address().port,apiKey:'offline-test-key',models:[{id:'gpt-image-test',name:'Image',protocol:'openai'},{id:'gpt-image-alternate',name:'Image alternate',protocol:'openai'}]}]
  if(${JSON.stringify(benchmark)}) {
   const samples=[]
   for(let trial=0;trial<5;trial++) {
    const start=performance.now()
    const result=await service.open({providers,bounds:{x:0,y:80,width:1000,height:680}})
    if(!result.ok)throw Error('benchmark_open_failed')
    const contents=service.view.webContents
    contents.setBackgroundThrottling(false)
    const deadline=Date.now()+10000
    const condition='document.querySelector("select")?.value === "offline"'
    while(!(await contents.executeJavaScript(condition))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20))
    if(!(await contents.executeJavaScript(condition)))throw Error('benchmark_not_ready')
    const readyMs=Math.round(performance.now()-start)
    await new Promise(resolve=>setTimeout(resolve,150))
    const workingSetKB=app.getAppMetrics().find(item=>item.pid===contents.getOSProcessId())?.memory.workingSetSize
    samples.push({surface:'workbench',trial,readyMs,workingSetKB})
    await service.close()
   }
   if(calls!==0)throw Error('benchmark_generated_image')
   require('node:fs').writeFileSync(${JSON.stringify(resolve('../workspace-docs/artifacts/image-page-performance.json'))},JSON.stringify({kind:'local-hidden-electron-ui-not-inference',platform:process.platform,arch:process.arch,hardwareAcceleration:false,generatedAt:new Date().toISOString(),samples},null,2))
   process.stdout.write('PASS: 5 workbench opens, readiness and renderer working set recorded; no generation requests\\n')
  }
  const opened=await service.open({providers,userFontFamily:'Consolas',bounds:{x:0,y:80,width:1000,height:680}})
  if(!opened.ok)throw Error('view_open_failed')
  service.setVisible(true)
  const view=service.view
  view.webContents.setBackgroundThrottling(false)
  const fontDeadline=Date.now()+5000
  while(!(await view.webContents.executeJavaScript('!!document.querySelector("button")'))&&Date.now()<fontDeadline)await new Promise(resolve=>setTimeout(resolve,30))
  const customFonts=await view.webContents.executeJavaScript('JSON.stringify([document.body,...document.querySelectorAll("h1,button,input,textarea,select")].filter(element=>element.getBoundingClientRect().width>0).map(element=>({tag:element.tagName,font:getComputedStyle(element).fontFamily})))')
  if(JSON.parse(customFonts).some(item=>!item.font.startsWith('Consolas')&&!item.font.startsWith('"Consolas"'))||JSON.parse(customFonts).length<2)throw Error('custom_font_not_inherited:'+customFonts)
  process.stdout.write('PASS: global custom font reaches visible headings, buttons and form controls\\n')
  const health=await view.webContents.executeJavaScript('JSON.stringify({bridge:typeof window.imageCanvas,api:typeof window.api,node:typeof window.require,body:document.body.innerText})')
  const state=JSON.parse(health)
  if(state.bridge!=='object'||state.api!=='undefined'||state.node!=='undefined'||!state.body.includes(${JSON.stringify(workbench ? '图片工作台' : 'Zen-AI')}))throw Error('invalid_page_isolation:'+health)
  const catalog=await view.webContents.executeJavaScript('window.imageCanvas.catalog()')
  if(JSON.stringify(catalog).includes('offline-test-key')||JSON.stringify(catalog).includes('127.0.0.1'))throw Error('catalog_secret_leak')
  for(let i=0;i<10;i++) {service.setVisible(false);service.resize({x:0,y:80,width:1000,height:680});service.setVisible(true)}
  if(service.view!==view||calls!==0||view.getBounds().y!==80)throw Error('mode_switch_recreated_view_or_covered_titlebar')
  process.stdout.write('PASS: 10 visibility switches keep the workbench instance and reserved titlebar; no generation requests\\n')
  const id=randomUUID()
  const request={id,providerId:'offline',modelId:'gpt-image-test',prompt:'Offline smoke',references:[],size:'1:1',quality:'auto',background:'',count:1}
  let firstId=id
  if(${JSON.stringify(workbench)}) {
   const hydrated=Date.now()+5000
   while(!(await view.webContents.executeJavaScript('document.querySelector("select")?.value === "offline"'))&&Date.now()<hydrated)await new Promise(resolve=>setTimeout(resolve,30))
   await view.webContents.executeJavaScript('(()=>{const area=document.querySelector("textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(area,"Offline UI generation");area.dispatchEvent(new Event("input",{bubbles:true}));})()')
   await new Promise(resolve=>setTimeout(resolve,100))
   const clicked=await view.webContents.executeJavaScript('(()=>{const button=document.querySelector("button.generate");if(button.disabled)return false;button.click();button.click();return true})()')
   if(!clicked)throw Error('workbench_form_not_ready')
   const accepted=Date.now()+5000
   while(!service.store().history().length&&Date.now()<accepted)await new Promise(resolve=>setTimeout(resolve,30))
   firstId=service.store().history()[0]?.id
   if(!firstId)throw Error('workbench_form_did_not_submit')
  } else service.store().submit(providers[0],request)
  await service.close()
  const deadline=Date.now()+10000
  while(service.store().task(firstId).status==='running'&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,30))
  if(service.store().task(firstId).status!=='completed'||calls!==1)throw Error('task_did_not_survive_close')
  if(!(await service.open({providers,bounds:{x:0,y:80,width:1000,height:680}})).ok)throw Error('reopen_failed')
  service.setVisible(true)
  const defaultFonts=await service.view.webContents.executeJavaScript('document.fonts.ready.then(()=>JSON.stringify({family:getComputedStyle(document.body).fontFamily,loaded:[...document.fonts].some(font=>font.family.includes("HarmonyOS Sans")&&font.status==="loaded")}))')
  if(!JSON.parse(defaultFonts).family.includes('HarmonyOS Sans')||JSON.parse(defaultFonts).family.includes('Consolas')||!JSON.parse(defaultFonts).loaded)throw Error('bundled_global_font_not_loaded:'+defaultFonts)
  process.stdout.write('PASS: default global font loads from bundled local assets after clearing custom font\\n')
  const restored=await service.view.webContents.executeJavaScript('window.imageCanvas.history()')
  if(!restored.some(task=>task.id===firstId&&task.assets.length===1))throw Error('recovery_failed')
  if(${JSON.stringify(workbench)}) {
   service.view.webContents.setBackgroundThrottling(false)
   for (const references of [[image,image],[image]]) {
    const payload={...request,id:randomUUID(),references:references.map(bytes=>'data:image/png;base64,'+bytes.toString('base64'))}
    service.store().submit(providers[0],payload)
    const deadline=Date.now()+5000
    while(service.store().task(payload.id).status==='running'&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,30))
    if(service.store().task(payload.id).status!=='completed')throw Error('reference_edit_failed')
    if(service.store().task(payload.id).referenceAssets.length!==references.length)throw Error('reference_snapshot_missing')
   }
   if(calls!==3)throw Error('unexpected_paid_request_count')
   await new Promise(resolve=>setTimeout(resolve,2200))
   const layout=await service.view.webContents.executeJavaScript('JSON.stringify({overflow:document.documentElement.scrollWidth>innerWidth,selectors:document.querySelectorAll("select").length,text:document.body.innerText})')
   if(JSON.parse(layout).overflow||JSON.parse(layout).selectors<4)throw Error('workbench_layout_failed:'+layout)
   service.resize({x:0,y:0,width:999,height:760})
   await new Promise(resolve=>setTimeout(resolve,100))
   service.resize({x:0,y:0,width:1000,height:760})
   let screen
   for(let attempt=0;attempt<5;attempt++) {
    await new Promise(resolve=>setTimeout(resolve,200))
    await service.view.webContents.executeJavaScript('Promise.race([new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))),new Promise(resolve=>setTimeout(resolve,400))])')
    screen=await service.view.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})
    if(!screen.isEmpty())break
   }
   if(screen.isEmpty())throw Error('empty_desktop_capture')
   const screenshot=${JSON.stringify(resolve('../workspace-docs/artifacts/image-workbench-desktop.png'))}
   require('node:fs').writeFileSync(screenshot,screen.toPNG())
   // Native dialog semantics: labeled, keyboard-contained and Escape returns focus.
   const contents=service.view.webContents
   await contents.executeJavaScript('(()=>{const button=document.querySelector(".image-button");button.focus();button.click()})()')
   await new Promise(resolve=>setTimeout(resolve,100))
   if(!(await contents.executeJavaScript('(()=>{const dialog=document.querySelector("dialog");return dialog?.open && !!document.getElementById(dialog.getAttribute("aria-labelledby"))?.textContent})()')))throw Error('dialog_missing_label')
   for(let index=0;index<3;index++) {
    contents.sendInputEvent({type:'keyDown',keyCode:'Tab'})
    contents.sendInputEvent({type:'keyUp',keyCode:'Tab'})
    await new Promise(resolve=>setTimeout(resolve,20))
    if(!(await contents.executeJavaScript('document.querySelector("dialog").contains(document.activeElement)')))throw Error('dialog_focus_escaped')
   }
   contents.sendInputEvent({type:'keyDown',keyCode:'Escape'})
   contents.sendInputEvent({type:'keyUp',keyCode:'Escape'})
   await new Promise(resolve=>setTimeout(resolve,100))
   if(!(await contents.executeJavaScript('!document.querySelector("dialog") && document.activeElement.classList.contains("image-button")')))throw Error('dialog_escape_focus_failed')
   // Hidden windows do not reliably advance compositor transitions. Capture
   // settled theme colors; reduced-motion behavior is already part of the CSS.
   await contents.insertCSS('*,*::before,*::after{transition:none!important;animation:none!important}')
   for(const theme of ['light','dark']) {
    await contents.executeJavaScript('document.documentElement.dataset.theme='+JSON.stringify(theme))
    await new Promise(resolve=>setTimeout(resolve,200))
    const contrast=await contents.executeJavaScript('(()=>{const rgb=value=>value.match(/[0-9.]+/g).slice(0,3).map(Number);const lum=value=>rgb(value).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);const ratio=(a,b)=>(Math.max(a,b)+.05)/(Math.min(a,b)+.05);const button=getComputedStyle(document.querySelector("button.generate"));const muted=getComputedStyle(document.querySelector(".muted"));return {button:ratio(lum(button.color),lum(button.backgroundColor)),muted:ratio(lum(muted.color),lum(getComputedStyle(document.querySelector(".topbar")).backgroundColor))}})()')
    if(contrast.button<4.5||contrast.muted<4.5)throw Error('theme_contrast_failed:'+theme+':'+JSON.stringify(contrast))
    await new Promise(resolve=>setTimeout(resolve,120))
    require('node:fs').writeFileSync(${JSON.stringify(resolve('../workspace-docs/artifacts/image-workbench-'))}+theme+'.png',(await contents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG())
   }
   process.stdout.write('PASS: light/dark text contrast >= 4.5, named dialog, Tab containment and Escape focus restoration\\n')
   process.stdout.write('PASS: prompt generation, single/multi-image edits, exact count, reference persistence, desktop layout; screenshot '+screenshot+'\\n')
   service.view.webContents.setBackgroundThrottling(false)
   service.resize({x:0,y:0,width:520,height:760})
   await new Promise(resolve=>setTimeout(resolve,200))
   if(await service.view.webContents.executeJavaScript('document.documentElement.scrollWidth>innerWidth'))throw Error('narrow_layout_overflow')
   await service.view.webContents.executeJavaScript('document.querySelector(".composer").scrollIntoView()')
   await new Promise(resolve=>setTimeout(resolve,100))
   const narrow=await service.view.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})
   if(narrow.isEmpty())throw Error('empty_narrow_capture')
   require('node:fs').writeFileSync(${JSON.stringify(resolve('../workspace-docs/artifacts/image-workbench-narrow.png'))},narrow.toPNG())
  }
  if(${JSON.stringify(workbench)} && !${JSON.stringify(packagedApp)}) {
   const contents=service.view.webContents
   service.resize({x:0,y:0,width:1000,height:760})
   const waitFor=async(condition)=>{const until=Date.now()+8000;while(!(await contents.executeJavaScript(condition))&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,50));if(!(await contents.executeJavaScript(condition)))throw Error('advanced_ui_not_ready:'+condition)}
   const clickText=async(text)=>{if(!(await contents.executeJavaScript('(()=>{const e=[...document.querySelectorAll("button,summary,label")].find(e=>e.textContent.trim()==='+JSON.stringify(text)+');if(!e)return false;e.click();return true})()')))throw Error('missing_advanced_control:'+text)}
   await contents.executeJavaScript('(()=>{const data=Uint8Array.from(atob('+JSON.stringify(image.toString('base64'))+'),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([data],"offline.png",{type:"image/png"}));const input=document.querySelector("input[type=file]");input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}))})()')
   await waitFor('document.querySelectorAll(".reference img").length===1')
   if(!(await contents.executeJavaScript('(()=>{const settings=document.querySelector("#image-advanced"),size=document.querySelector("select[aria-label=图片尺寸]");return !!settings && !settings.querySelector("details") && settings.lastElementChild.classList.contains("model-comparison") && !!size && size.options[0].textContent==="自动（智能匹配）" && !document.querySelector(".more-button")})()')))throw Error('expanded_settings_or_size_selector_invalid')
   await clickText('涂抹需要重绘的区域')
   await waitFor('document.querySelector(".mask-stage canvas")?.width===960')
   const bounds=await contents.executeJavaScript('(()=>{const canvas=document.querySelector(".mask-stage canvas"),a=canvas.getBoundingClientRect(),b=document.querySelector(".mask-stage img").getBoundingClientRect();return {x:a.x+a.width/2,y:a.y+a.height/2,aligned:Math.abs(a.width-b.width)<1&&Math.abs(a.height-b.height)<1}})()')
   if(!bounds.aligned)throw Error('mask_overlay_misaligned')
   contents.sendInputEvent({type:'mouseMove',x:Math.round(bounds.x),y:Math.round(bounds.y)})
   contents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:Math.round(bounds.x),y:Math.round(bounds.y)})
   contents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:Math.round(bounds.x),y:Math.round(bounds.y)})
   await waitFor('!document.querySelector("dialog button.primary").disabled')
   await contents.executeJavaScript('document.querySelector("dialog button.primary").click()')
   await waitFor('!document.querySelector("dialog") && !document.querySelector("button.generate").disabled')
   await contents.executeJavaScript('document.querySelector("button.generate").click()')
   await waitFor('window.imageCanvas.history().then(items=>items.some(task=>task.maskAsset&&task.status==="completed"))')
   await clickText('Offline smoke · Image alternate')
   await waitFor('document.querySelector("button.generate").textContent.includes("2") && !document.querySelector("button.generate").disabled')
   await contents.executeJavaScript('document.querySelector("button.generate").click()')
   await waitFor('window.imageCanvas.history().then(items=>items.filter(task=>task.batchId&&task.status==="completed").length===2)')
   await waitFor('document.querySelectorAll(".comparison-card").length===2')
   await contents.executeJavaScript('document.documentElement.dataset.theme="light"')
   service.resize({x:0,y:0,width:999,height:760})
   await new Promise(resolve=>setTimeout(resolve,150))
   service.resize({x:0,y:0,width:1000,height:760})
   await new Promise(resolve=>setTimeout(resolve,800))
   require('node:fs').writeFileSync(${JSON.stringify(resolve('../workspace-docs/artifacts/image-workbench-comparison.png'))},(await contents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG())
   if(calls!==6)throw Error('advanced_generation_count:'+calls)
   process.stdout.write('PASS: real pointer mask painting, aligned overlay, masked task persistence, two-model batch and result cards; six local generation requests total\\n')
   const historyBefore=(await service.store().history()).length
   await contents.executeJavaScript('document.querySelector(".topbar button.primary").click()')
   const blank='!document.querySelector(".preview img, .reference img, .comparison-card, .task-info") && document.querySelector("textarea").value === "" && document.querySelector("select").value === "offline"'
   await waitFor(blank)
   await new Promise(resolve=>setTimeout(resolve,2200))
   if(!(await contents.executeJavaScript(blank)))throw Error('new_image_restored_old_result')
   if((await service.store().history()).length!==historyBefore||calls!==6)throw Error('new_image_changed_tasks')
   require('node:fs').writeFileSync(${JSON.stringify(resolve('../workspace-docs/artifacts/image-workbench-new-image.png'))},(await contents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG())
   process.stdout.write('PASS: new image clears canvas, references and comparisons, preserves provider and history, stays blank after polling, and creates no generation request\\n')
  }
  const blocked=await service.view.webContents.executeJavaScript('fetch("http://127.0.0.1:'+server.address().port+'/forbidden").then(()=>false,()=>true)')
  if(!blocked)throw Error('page_network_not_blocked')
  await service.close();window.destroy()
  process.stdout.write('PASS: sandboxed preload, local page, secret-free catalog, task survives close, history recovery, page network blocked\\n')
  app.exit(0)
 }catch(error){process.stderr.write(String(error)+'\\n');app.exit(1)}finally{server?.close()}
})
`
  )
  // Build alongside out/main so the production preload path is exercised exactly.
  await build({
    configFile: false,
    ...(packagedApp ? { define: { __dirname: JSON.stringify(resolve(packagedApp, 'out/main')) } } : {}),
    plugins: [
      {
        name: 'smoke-logger',
        resolveId(id) {
          if (id === '@logger') return '\0smoke-logger'
          if (id.startsWith('@shared/')) return resolve('packages/shared', `${id.slice(8)}.ts`)
          return null
        },
        load(id) {
          if (id === '\0smoke-logger')
            return 'export const loggerService = { withContext: () => ({ info: () => {}, warn: () => {}, error: (...args) => process.stderr.write(String(args[1]) + "\\n") }) }'
          return null
        }
      }
    ],
    resolve: { alias: { '@logger': resolve(directory, 'logger.ts'), '@shared': resolve('packages/shared') } },
    build: {
      outDir: resolve('out/main'),
      emptyOutDir: false,
      minify: false,
      lib: { entry: resolve(directory, 'entry.ts'), formats: ['cjs'], fileName: () => 'image-canvas-smoke.cjs' },
      rollupOptions: {
        external: (id) => id.startsWith('node:') || ['electron', 'sharp'].includes(id),
        output: { inlineDynamicImports: true }
      }
    }
  })
  const electron = (await import('electron')).default as unknown as string
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const result = await new Promise<number>((done, reject) => {
    const child = spawn(electron, [resolve('out/main/image-canvas-smoke.cjs')], {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
      env: environment
    })
    const timeout = setTimeout(
      () => {
        child.kill()
        reject(new Error('Electron smoke timed out'))
      },
      benchmark ? 90000 : 45000
    )
    child.on('error', reject)
    child.on('exit', (code) => {
      clearTimeout(timeout)
      done(code ?? 1)
    })
  })
  process.exitCode = result
}
void main().catch((error) => {
  process.stderr.write(String(error))
  process.exitCode = 1
})
