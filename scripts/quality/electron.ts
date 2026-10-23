import { execFile } from 'node:child_process'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { _electron, type ElectronApplication, type Page } from '@playwright/test'

import { APP_QUIT_CLEANUP_TIMEOUT_MS } from '../../packages/shared/config/constant'
import { listenOnLoopback } from '../../packages/shared/utils/loopbackServer'
import { offlineEnvironment } from './process'
import { mountQualityPython, type QualityPythonRuntime } from './python-runtime'
import { inferUIWaitPhase, type UIWaitPhase, type UIWaitProgress } from './ui-progress'

export function within(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('路径不在本次隔离工作区内。')
  return target
}

export async function launchIsolated(
  root: string,
  directory: string,
  signal?: AbortSignal,
  python?: QualityPythonRuntime
) {
  const instance = path.join(directory, 'instance')
  await mkdir(instance, { recursive: true })
  await writeFile(path.join(instance, '.quality-instance'), 'zen-quality-isolated-v1', { flag: 'wx' })
  if (python) await mountQualityPython(root, instance, python)
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
  if (signal?.aborted) throw new Error('已取消')
  const application = await _electron.launch({
    args: [path.join(root, 'scripts/quality/electron-entry.cjs')],
    cwd: root,
    env: Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    ),
    timeout: 60000
  })
  const cancelled = () => {
    void application.close().catch(() => {})
  }
  signal?.addEventListener('abort', cancelled, { once: true })
  try {
    if (signal?.aborted) throw new Error('已取消')
    const page = await application.firstWindow({ timeout: 60000 })
    await page.waitForFunction(() => Boolean((window as any).store?.getState?.()._persist?.rehydrated), undefined, {
      timeout: 60000
    })
    const actual = await application.evaluate(({ app }) => app.getPath('userData'))
    if ((await realpath(actual)) !== (await realpath(path.join(instance, 'userData'))))
      throw new Error('产品userData不在隔离目录，拒绝测试。')
    return { application, page, instance }
  } catch (error) {
    try {
      await closeIsolated(application)
    } catch (cleanupError) {
      throw Object.assign(new Error(`${String(error)}；启动失败清理：${String(cleanupError)}`), {
        isolationCleanupUnconfirmed: true
      })
    }
    throw error
  } finally {
    signal?.removeEventListener('abort', cancelled)
  }
}

export async function verifyIsolatedPython(page: Page, runtime: QualityPythonRuntime) {
  const status = await page.evaluate(async () => (await (window as any).api.checkAssistantEnvironment()).python)
  if (!status.installed || typeof status.path !== 'string')
    throw new Error(`隔离产品未能使用已准备的 Zen Python：${status.message ?? '未就绪'}`)
  within(await realpath(path.join(runtime.cacheDir, 'python')), await realpath(status.path))
}

async function isolatedRenderer(application: ElectronApplication) {
  const proof = await application.evaluate(({ app }) => ({
    name: app.getName(),
    instance: process.env.ZEN_QUALITY_INSTANCE,
    project: process.env.ZEN_QUALITY_PROJECT,
    userData: app.getPath('userData')
  }))
  if (
    proof.name !== 'ZenAIQuality' ||
    !proof.instance ||
    !path.isAbsolute(proof.instance) ||
    !proof.project ||
    !path.isAbsolute(proof.project)
  )
    throw new Error('缺少隔离实例证据，拒绝停止任何会话。')
  const instance = await realpath(proof.instance)
  const marker = path.join(instance, '.quality-instance')
  const markerInfo = await lstat(marker)
  if (
    !markerInfo.isFile() ||
    markerInfo.isSymbolicLink() ||
    (await readFile(marker, 'utf8')) !== 'zen-quality-isolated-v1' ||
    (await realpath(proof.userData)) !== (await realpath(path.join(instance, 'userData')))
  )
    throw new Error('隔离标记或userData不匹配，拒绝停止任何会话。')

  return path.join(await realpath(proof.project), 'out', 'renderer', 'index.html')
}

/** Only use existing product controls, after proving this is a disposable quality instance. */
export async function stopIsolatedTask(application: ElectronApplication) {
  await stopIsolatedPages(application, await isolatedRenderer(application))
}

async function stopIsolatedPages(application: ElectronApplication, renderer: string) {
  const pages = application.windows().filter((page) => {
    if (page.isClosed()) return false
    const url = new URL(page.url())
    return url.protocol === 'file:' && path.resolve(fileURLToPath(url)) === renderer
  })
  if (!pages.length) throw new Error('隔离应用没有可核对的产品页面，无法确认任务停止。')
  for (const page of pages) {
    const readActivity = () =>
      page.evaluate(() => {
        const state = (window as any).store?.getState?.()
        if (!state?.messages?.entities || !state?.toolPermissions?.requests)
          throw new Error('隔离页面任务状态尚未就绪。')
        const requests = Object.values<{ toolCallId: string; status: string }>(state.toolPermissions.requests)
        return {
          busy:
            requests.length > 0 ||
            Object.values(state.messages.loadingByTopic ?? {}).some(Boolean) ||
            Object.values<any>(state.messages.entities).some(
              (message) => message?.role === 'assistant' && ['pending', 'processing'].includes(message.status)
            ),
          pending: requests.filter((request) => request.status === 'pending').map((request) => request.toolCallId)
        }
      })
    // InputbarCore's existing onPause control; never a generic Run/approval button.
    const pause = page.locator('#inputbar button:has(svg.lucide-circle-pause)').filter({ visible: true })
    const denied = new Set<string>()
    const deadline = Date.now() + 10000
    let stopped = false
    while (Date.now() < deadline) {
      const pauseCount = await pause.count()
      if (pauseCount > 1) throw new Error('隔离页面暂停按钮不唯一，拒绝猜测停止目标。')
      if (pauseCount) {
        await pause.click({ timeout: 2000 })
      }
      const activity = await readActivity()
      for (const toolCallId of activity.pending) {
        if (!toolCallId) throw new Error('待审批工具缺少身份，拒绝猜测取消目标。')
        if (denied.has(toolCallId)) continue
        const escaped = toolCallId.replace(/[^a-zA-Z0-9_-]/gu, (value) => `\\${value.codePointAt(0)!.toString(16)} `)
        const identity = `[data-tool-call-id="${escaped}"]`
        const card = page.locator(`[data-tool-permission-card]${identity}`).filter({ visible: true })
        if (!(await card.count())) {
          if (!(await readActivity()).pending.includes(toolCallId)) continue
          const header = page.locator(`[data-tool-permission-header]${identity}`).filter({ visible: true })
          if ((await header.count()) !== 1) throw new Error('找不到唯一待审批卡片，无法安全取消。')
          const group = header.locator('xpath=ancestor::*[@aria-expanded][1]')
          if ((await group.getAttribute('aria-expanded')) === 'false')
            await group.locator('.ant-collapse-expand-icon').click({ timeout: 2000 })
          await card.waitFor({ state: 'visible', timeout: 2000 })
        }
        if ((await card.count()) !== 1) throw new Error('待审批卡片不唯一，拒绝猜测取消目标。')
        if (!(await readActivity()).pending.includes(toolCallId)) continue
        // ToolApprovalActions.cancel sends deny. Do not click Run or submit permission APIs directly.
        await card.getByRole('button', { name: /^(取\s*消|Cancel)$/i }).click({ timeout: 2000 })
        denied.add(toolCallId)
      }
      if (!(await readActivity()).busy && !(await pause.count())) {
        stopped = true
        break
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
    if (!stopped) throw new Error('隔离任务停止未确认（仍在生成或等待审批），保留清理失败。')
  }
}

export async function closeIsolated(application: ElectronApplication) {
  const child = application.process()
  let stopFailed = false
  let stopError: unknown
  if (child.exitCode === null && child.signalCode === null) {
    // Without isolation evidence, do not close or kill an unrelated user's application either.
    const renderer = await isolatedRenderer(application)
    try {
      await stopIsolatedPages(application, renderer)
    } catch (error) {
      stopFailed = true
      stopError = error
    }
  }
  // Allow the product's cleanup deadline plus transport/process exit propagation.
  const closeTimeoutMs = APP_QUIT_CLEANUP_TIMEOUT_MS + 5000
  const closeDeadline = Date.now() + closeTimeoutMs
  let closeTimer: NodeJS.Timeout | undefined
  const clean = await Promise.race([
    Promise.resolve()
      .then(() => application.close())
      .then(
        () => true,
        () => false
      ),
    new Promise<boolean>((resolve) => {
      closeTimer = setTimeout(() => resolve(false), closeTimeoutMs)
      closeTimer.unref()
    })
  ]).finally(() => clearTimeout(closeTimer))
  // Playwright can lose its connection during shutdown; confirm the owned process independently.
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        child.off('exit', done)
        resolve()
      }
      const timer = setTimeout(done, Math.max(2000, closeDeadline - Date.now()))
      child.once('exit', done)
    })
  }
  if (child.exitCode === 0 && child.signalCode === null && !stopFailed) return
  const preKillExit = child.exitCode
  const preKillSignal = child.signalCode
  let forced = false
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    forced = true
    if (process.platform === 'win32')
      await new Promise<void>((resolve) =>
        execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 8000 }, () =>
          resolve()
        )
      )
    else child.kill('SIGKILL')
  }
  throw new Error(
    `隔离应用未正常退出（close=${clean}, exit=${preKillExit}, signal=${preKillSignal}, stop=${stopFailed ? 'failed' : 'ok'}, forced=${forced}）` +
      (stopFailed ? `；停止隔离任务失败：${String(stopError)}` : '') +
      (forced
        ? `；强制清理前 preKillExit=${preKillExit}, preKillSignal=${preKillSignal}；强制清理后 postKillExit=${child.exitCode}, postKillSignal=${child.signalCode}（不代表产品自身崩溃）`
        : '') +
      '；需复核。'
  )
}

export async function seedModel(
  page: Page,
  input: { url: string; token: string; modelId: string; maxOutput: number; contextWindowTokens?: number }
) {
  const lease = createServer()
  await listenOnLoopback(lease)
  const port = (lease.address() as AddressInfo).port
  await new Promise<void>((resolve) => lease.close(() => resolve()))
  await page.evaluate(
    async ({ url, token, modelId, maxOutput, contextWindowTokens, port }) => {
      const store = (window as any).store
      const model = {
        id: modelId,
        name: modelId,
        provider: 'quality-selected',
        group: 'quality',
        ...(contextWindowTokens ? { contextWindowTokens } : {})
      }
      const provider = {
        id: 'quality-selected',
        name: 'Quality selected Provider',
        type: 'openai',
        apiHost: url,
        apiKey: token,
        enabled: true,
        models: [model]
      }
      store.dispatch({ type: 'llm/updateProviders', payload: [provider] })
      store.dispatch({ type: 'llm/setDefaultModel', payload: { model } })
      store.dispatch({ type: 'llm/setQuickModel', payload: { model } })
      store.dispatch({ type: 'llm/setTranslateModel', payload: { model } })
      store.dispatch({ type: 'settings/setApiServerPort', payload: port })
      store.dispatch({ type: 'settings/setApiServerEnabled', payload: true })
      const assistant = store.getState().assistants.assistants[0]
      store.dispatch({
        type: 'assistants/updateAssistant',
        payload: {
          id: assistant.id,
          model,
          defaultModel: model,
          settings: {
            ...assistant.settings,
            enableTopP: false,
            topP: 1,
            enableMaxTokens: true,
            maxTokens: maxOutput
          }
        }
      })
      const result = await (window as any).api.apiServer.restart()
      if (!result.success) throw new Error('隔离API服务器启动失败：' + result.error)
      store.dispatch({ type: 'runtime/setApiServerRunningAction', payload: true })
    },
    { ...input, port }
  )
}

/** Stub only the native OS picker; upload/storage/parsing/composer still use product code. */
export async function attachFiles(
  instance: Awaited<ReturnType<typeof launchIsolated>>,
  files: string[],
  entry: string
) {
  for (const file of files) within(instance.instance, await realpath(file))
  await instance.application.evaluate(({ dialog }, selected) => {
    const original = dialog.showOpenDialog
    dialog.showOpenDialog = (async () => {
      dialog.showOpenDialog = original
      return { canceled: false, filePaths: selected }
    }) as typeof dialog.showOpenDialog
  }, files)
  if (entry === 'assistant') {
    await instance.page
      .locator('#inputbar')
      .getByRole('button', { name: /^(更多|More)$/i })
      .click()
    await instance.page
      .getByText(/^(上传附件|Upload Attachments|Upload attachment)$/i)
      .last()
      .click()
  } else
    await instance.page
      .locator('#inputbar')
      .getByRole('button', { name: /上传图片或文档|上传文档|Upload.*(?:document|file)/i })
      .first()
      .click()
  for (const file of files)
    await instance.page
      .getByTitle(path.basename(file), { exact: true })
      .first()
      .waitFor({ state: 'visible', timeout: 15000 })
}

export async function checkHistory(page: Page, entry: string) {
  const before = (await readMessages(page)).filter(
    (message) => message.role === 'assistant' && message.status === 'success' && message.text.trim()
  )
  if (!before.length) throw new Error('没有可核对的完成消息。')
  await page.reload()
  await page.waitForFunction(() => Boolean((window as any).store?.getState?.()._persist?.rehydrated), undefined, {
    timeout: 60000
  })
  await openEntry(page, entry)
  await page.waitForFunction(
    (ids) => {
      const state = (window as any).store.getState()
      return ids.every((id) => Boolean(state.messages.entities[id]))
    },
    before.map((message) => message.id),
    { timeout: 15000 }
  )
  const after = await readMessages(page)
  for (const message of before)
    if (!after.some((item) => item.id === message.id && item.text === message.text && item.status === 'success'))
      throw new Error('重新加载后已完成回答丢失、被截断或状态改变。')
  return { checkedMessages: before.length, reloadVerified: true }
}

export async function readMessages(page: Page) {
  return page.evaluate(() => {
    const state = (window as any).store.getState()
    return Object.values(state.messages.entities)
      .filter(Boolean)
      .map((message: any) => ({
        id: message.id,
        role: message.role,
        status: message.status,
        error: (message.blocks ?? [])
          .map((id: string) => state.messageBlocks.entities[id])
          .filter((block: any) => block?.type === 'error')
          .map((block: any) => block.error?.message ?? block.content ?? '产品返回错误')
          .join('\n'),
        text: (message.blocks ?? [])
          .map((id: string) => state.messageBlocks.entities[id])
          .filter((block: any) => block?.type === 'main_text')
          .map((block: any) => block.content)
          .join('\n')
      })) as Array<{ id: string; role: string; status: string; text: string; error?: string }>
  })
}

export async function openEntry(page: Page, entry: string) {
  await page.evaluate(
    (route) => {
      window.location.hash = route
    },
    entry === 'assistant' ? '/new-assistant' : '/'
  )
  if (entry === 'assistant') {
    const enable = page.getByRole('button', { name: /启用并启动|Enable and Start/i })
    const start = page.getByRole('button', { name: /^启\s*动$|^Start$/i })
    const create = page.getByRole('button', { name: /新建对话|New Conversation|New Chat/i }).first()
    const input = page.locator('#inputbar textarea').first()
    const deadline = performance.now() + 30000
    while (performance.now() < deadline) {
      if (await input.isVisible()) return
      if (await enable.isVisible()) await enable.click()
      else if (await start.isVisible()) await start.click()
      else if (await create.isVisible()) await create.click()
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error('助手入口未在隔离环境准备完成，未发送模型请求。')
  }
}

export async function sendUI(
  page: Page,
  prompt: string,
  timeoutMs: number,
  signal?: AbortSignal,
  progress: {
    checkFailure?: () => void | Promise<void>
    onWaiting?: (elapsedMs: number, progress: UIWaitProgress) => void
  } = {}
) {
  const before = new Set((await readMessages(page)).map((message) => message.id))
  const started = performance.now()
  let firstTextMs: number | null = null
  let lastProgress = started
  let lastPhase: UIWaitPhase | undefined
  const textarea = page.locator('#inputbar textarea').filter({ visible: true }).first()
  await textarea.fill(prompt, { timeout: 15000 })
  await page.locator('#inputbar [role="button"][aria-disabled="false"].icon-ic_send').click({ timeout: 15000 })
  while (performance.now() - started < timeoutMs) {
    if (signal?.aborted) throw new Error('已取消')
    await progress.checkFailure?.()
    const replies = (await readMessages(page)).filter(
      (message) => !before.has(message.id) && message.role === 'assistant'
    )
    if (firstTextMs === null && replies.some((message) => message.text.trim()))
      firstTextMs = performance.now() - started
    const failure = replies.find((message) => ['error', 'paused'].includes(message.status) || message.error)
    if (failure) throw new Error(`产品回答最终状态为${failure.status}：${failure.error || '回答失败或已停止'}`)
    if (
      replies.length &&
      replies.every((message) => message.status === 'success') &&
      !replies.some((message) => message.text.trim())
    )
      throw new Error('产品状态完成但最终回答为空，判为失败。')
    if (
      replies.length &&
      replies.every((message) => message.status === 'success') &&
      replies.some((message) => message.text.trim())
    ) {
      const answer = replies.map((message) => message.text).join('\n')
      if (!(await page.locator('.message-assistant').last().innerText()).trim())
        throw new Error('状态完成但页面回答为空。')
      return {
        answer,
        firstTextMs,
        totalMs: performance.now() - started,
        messageIds: replies.map((message) => message.id)
      }
    }
    if (progress.onWaiting) {
      const waiting = await page.evaluate(
        (ids) => {
          const state = (window as any).store.getState()
          const blocks = ids.flatMap((id) => state.messages.entities[id]?.blocks ?? [])
          return {
            tools: blocks
              .map((id: string) => state.messageBlocks.entities[id]?.metadata?.rawMcpToolResponse)
              .filter(Boolean),
            permissions: Object.values(state.toolPermissions.requests)
          }
        },
        replies.map((message) => message.id)
      )
      const phase = inferUIWaitPhase(waiting.tools, waiting.permissions as Parameters<typeof inferUIWaitPhase>[1])
      if (phase !== lastPhase || performance.now() - lastProgress >= 15000) {
        progress.onWaiting(performance.now() - started, { phase })
        lastProgress = performance.now()
        lastPhase = phase
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('产品未在任务超时前得到非空最终回答。')
}

export async function assistantWorkspace(page: Page, instance: string) {
  const session = await page.evaluate(async () => {
    const state = (window as any).store.getState()
    const { host, port, apiKey } = state.settings.apiServer
    const response = await fetch(`http://${host}:${port}/v1/new-assistant/agents/sessions?limit=10`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    })
    if (!response.ok) throw new Error('无法读取本次助手会话。')
    const payload = await response.json()
    return payload.data?.[0]
  })
  const workspace = session?.accessible_paths?.[0]
  if (typeof workspace !== 'string') throw new Error('没有已授权的助手工作目录。')
  within(instance, await realpath(workspace))
  return workspace
}

export async function prepareToolFixture(page: Page, instance: string) {
  const workspace = await assistantWorkspace(page, instance)
  const source = path.join(workspace, 'quality-source.json')
  const output = path.join(workspace, 'quality-result.txt')
  const content = JSON.stringify({ amounts: [3, 7, 11], note: '合成质检资料，不含用户数据' })
  await writeFile(source, content, { flag: 'wx' })
  return {
    workspace,
    source,
    output,
    content,
    prompt: `请读取这个JSON文件：${source}。计算amounts的合计，把合计写到${output}，不要修改原文件。完成后告诉我保存在哪里。如果某种方式需要额外权限而被拒绝，请换一种安全方式完成，不要反复申请相同权限。`
  }
}

export async function checkToolOutput(fixture: { workspace: string; source: string; output: string; content: string }) {
  for (const file of [fixture.source, fixture.output]) {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
      throw new Error('产物不是受限工作区内的普通小文件。')
    within(await realpath(fixture.workspace), await realpath(file))
  }
  if ((await readFile(fixture.source, 'utf8')) !== fixture.content) throw new Error('源文件被改变。')
  const result = await readFile(fixture.output, 'utf8')
  if (!/(^|\D)21(\D|$)/.test(result)) throw new Error('实际产物没有正确合计21。')
}
