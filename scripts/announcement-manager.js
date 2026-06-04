#!/usr/bin/env node

const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { URL } = require('node:url')

const DEFAULT_FILE = '/opt/zen-ai-update/html/zen-ai/announcements.json'
const DEFAULT_PORT = 37891

const config = {
  file: process.env.ANNOUNCEMENT_FILE || DEFAULT_FILE,
  host: process.env.ANNOUNCEMENT_MANAGER_HOST || '127.0.0.1',
  password: process.env.ANNOUNCEMENT_MANAGER_PASSWORD || '',
  port: Number.parseInt(process.env.ANNOUNCEMENT_MANAGER_PORT || `${DEFAULT_PORT}`, 10),
  username: process.env.ANNOUNCEMENT_MANAGER_USER || 'admin'
}

const nowIso = () => new Date().toISOString()

const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store'
  })
  res.end(typeof body === 'string' ? body : JSON.stringify(body, null, 2))
}

const safeEqual = (left, right) => {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

const isAuthorized = (req) => {
  if (!config.password && process.env.ANNOUNCEMENT_MANAGER_ALLOW_NO_PASSWORD === 'true') {
    return true
  }

  const header = req.headers.authorization || ''
  if (!header.startsWith('Basic ')) {
    return false
  }

  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
  const separatorIndex = decoded.indexOf(':')
  if (separatorIndex < 0) {
    return false
  }

  const username = decoded.slice(0, separatorIndex)
  const password = decoded.slice(separatorIndex + 1)
  return safeEqual(username, config.username) && safeEqual(password, config.password)
}

const requireAuth = (req, res) => {
  if (isAuthorized(req)) {
    return true
  }

  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Zen AI Announcement Manager"',
    'Content-Type': 'text/plain; charset=utf-8'
  })
  res.end('Authentication required')
  return false
}

const readBody = async (req) => {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  const body = Buffer.concat(chunks).toString('utf8')
  return body ? JSON.parse(body) : {}
}

const ensurePayload = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { version: 1, updatedAt: nowIso(), items: [] }
  }

  return {
    version: 1,
    updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : nowIso(),
    items: Array.isArray(payload.items) ? payload.items.map(normalizeItem).filter(Boolean) : []
  }
}

const normalizeItem = (item) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return null
  }

  if (typeof item.id !== 'string' || !item.id.trim()) return null
  if (!['announcement', 'urgent'].includes(item.type)) return null

  const normalized = {
    id: item.id.trim(),
    type: item.type,
    enabled: item.enabled !== false,
    title: typeof item.title === 'string' ? item.title.trim() : '',
    content: typeof item.content === 'string' ? item.content.trim() : ''
  }

  if (!normalized.title || !normalized.content) {
    return null
  }

  if (['info', 'success', 'warning', 'error'].includes(item.level)) normalized.level = item.level
  if (Number.isFinite(item.priority)) normalized.priority = item.priority
  if (Array.isArray(item.platforms)) {
    const platforms = item.platforms.filter((platform) => ['win32', 'darwin', 'linux'].includes(platform))
    if (platforms.length > 0) normalized.platforms = [...new Set(platforms)]
  }
  if (typeof item.minAppVersion === 'string' && item.minAppVersion.trim()) normalized.minAppVersion = item.minAppVersion.trim()
  if (typeof item.maxAppVersion === 'string' && item.maxAppVersion.trim()) normalized.maxAppVersion = item.maxAppVersion.trim()
  if (typeof item.startsAt === 'string' && item.startsAt.trim()) normalized.startsAt = item.startsAt.trim()
  if (typeof item.endsAt === 'string' && item.endsAt.trim()) normalized.endsAt = item.endsAt.trim()
  if (item.link && typeof item.link === 'object' && typeof item.link.url === 'string' && item.link.url.trim()) {
    normalized.link = {
      label: typeof item.link.label === 'string' && item.link.label.trim() ? item.link.label.trim() : '查看详情',
      url: item.link.url.trim()
    }
  }

  return normalized
}

const readPayload = () => {
  if (!fs.existsSync(config.file)) {
    return { version: 1, updatedAt: nowIso(), items: [] }
  }

  return ensurePayload(JSON.parse(fs.readFileSync(config.file, 'utf8')))
}

const backupExistingFile = () => {
  if (!fs.existsSync(config.file)) {
    return null
  }

  const backupPath = `${config.file}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`
  fs.copyFileSync(config.file, backupPath)
  return backupPath
}

const writePayload = (payload) => {
  const normalized = ensurePayload(payload)
  normalized.updatedAt = nowIso()

  fs.mkdirSync(path.dirname(config.file), { recursive: true })
  const backupPath = backupExistingFile()
  const tempPath = `${config.file}.${process.pid}.tmp`
  fs.writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  fs.renameSync(tempPath, config.file)

  return { payload: normalized, backupPath }
}

const slugify = (value) => {
  const fallback = `announcement-${Date.now()}`
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || fallback
  )
}

const upsertItem = (item) => {
  const payload = readPayload()
  const normalized = normalizeItem({ ...item, id: item.id || slugify(item.title) })

  if (!normalized) {
    throw new Error('公告内容不完整，请至少填写类型、标题和正文。')
  }

  const duplicated = payload.items.some((existing) => existing.id === normalized.id && existing.id !== item.originalId)
  if (duplicated) {
    normalized.id = `${normalized.id}-${Date.now()}`
  }

  const index = payload.items.findIndex((existing) => existing.id === (item.originalId || normalized.id))
  if (index >= 0) {
    payload.items[index] = normalized
  } else {
    payload.items.unshift(normalized)
  }

  return writePayload(payload)
}

const patchItem = (id, patch) => {
  const payload = readPayload()
  const item = payload.items.find((existing) => existing.id === id)
  if (!item) {
    throw new Error(`未找到公告：${id}`)
  }
  Object.assign(item, patch)
  return writePayload(payload)
}

const deleteItem = (id) => {
  const payload = readPayload()
  payload.items = payload.items.filter((item) => item.id !== id)
  return writePayload(payload)
}

const html = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Zen AI 公告管理器</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f1e8;
      --panel: rgba(255,255,255,.78);
      --ink: #1f2933;
      --muted: #6b7280;
      --line: rgba(39,47,57,.12);
      --accent: #0f766e;
      --danger: #c2410c;
      --shadow: 0 18px 50px rgba(53, 44, 31, .12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(20, 184, 166, .18), transparent 34rem),
        linear-gradient(135deg, #f8f4ea 0%, #eef4ef 100%);
    }
    header {
      padding: 32px clamp(18px, 4vw, 52px) 18px;
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 20px;
    }
    h1 { margin: 0; font-size: clamp(26px, 4vw, 40px); letter-spacing: -.04em; }
    .sub { margin-top: 8px; color: var(--muted); font-size: 14px; }
    main {
      padding: 0 clamp(18px, 4vw, 52px) 48px;
      display: grid;
      grid-template-columns: minmax(320px, 440px) minmax(360px, 1fr);
      gap: 22px;
      align-items: start;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 22px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(18px);
    }
    form { padding: 22px; display: grid; gap: 14px; }
    label { display: grid; gap: 7px; font-size: 13px; font-weight: 700; }
    input, textarea, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(255,255,255,.78);
      color: var(--ink);
      padding: 10px 12px;
      font: inherit;
      outline: none;
    }
    textarea { min-height: 128px; resize: vertical; line-height: 1.55; }
    input:focus, textarea:focus, select:focus { border-color: rgba(15,118,110,.55); box-shadow: 0 0 0 3px rgba(15,118,110,.1); }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .checks { display: flex; gap: 14px; flex-wrap: wrap; color: var(--muted); font-weight: 500; }
    .checks label { display: flex; align-items: center; gap: 6px; font-weight: 500; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; }
    button {
      border: 0;
      border-radius: 999px;
      padding: 10px 16px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      background: #e7ece7;
      color: var(--ink);
    }
    button.primary { background: var(--accent); color: white; }
    button.danger { background: #fee4d5; color: var(--danger); }
    button:disabled { opacity: .55; cursor: not-allowed; }
    .list { padding: 18px; display: grid; gap: 12px; }
    .item {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 15px;
      background: rgba(255,255,255,.62);
    }
    .item-top { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
    .title { font-size: 16px; font-weight: 800; }
    .meta { margin-top: 5px; color: var(--muted); font-size: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
    .content { margin-top: 11px; color: #374151; line-height: 1.65; white-space: pre-wrap; }
    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 12px;
      font-weight: 800;
      background: #e8f3ef;
      color: #0f766e;
      white-space: nowrap;
    }
    .badge.urgent { background: #fff1e8; color: #c2410c; }
    .disabled { opacity: .56; }
    .toast {
      position: fixed;
      right: 22px;
      bottom: 22px;
      background: #17202a;
      color: white;
      padding: 12px 16px;
      border-radius: 14px;
      box-shadow: var(--shadow);
      transform: translateY(120px);
      transition: transform .22s ease;
      max-width: min(520px, calc(100vw - 44px));
      z-index: 10;
    }
    .toast.show { transform: translateY(0); }
    .status {
      display: none;
      border-radius: 14px;
      padding: 11px 13px;
      font-size: 13px;
      line-height: 1.5;
      background: #edf7f4;
      color: #0f766e;
      border: 1px solid rgba(15, 118, 110, .18);
    }
    .status.show { display: block; }
    .status.error {
      background: #fff1e8;
      color: #c2410c;
      border-color: rgba(194, 65, 12, .2);
    }
    .list-note {
      border-radius: 14px;
      padding: 11px 13px;
      font-size: 13px;
      line-height: 1.5;
      background: #fff8e5;
      color: #92400e;
      border: 1px solid rgba(146, 64, 14, .18);
    }
    .empty { color: var(--muted); text-align: center; padding: 80px 20px; }
    @media (max-width: 920px) {
      header { align-items: flex-start; flex-direction: column; }
      main { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>公告管理器</h1>
      <div class="sub">直接管理 announcements.json。保存前会自动备份旧文件。</div>
    </div>
    <button onclick="loadPayload()">刷新</button>
  </header>
  <main>
    <section class="card">
      <form id="form" action="javascript:void(0)">
        <div class="status" id="status"></div>
        <input type="hidden" id="originalId" />
        <div class="row">
          <label>类型
            <select id="type">
              <option value="announcement">普通公告</option>
              <option value="urgent">紧急信息</option>
            </select>
          </label>
          <label>优先级（紧急信息数字越大越靠前）
            <input id="priority" type="number" placeholder="100" />
          </label>
        </div>
        <label>ID（留空自动生成；同 ID 关闭后不会重复弹窗）
          <input id="id" placeholder="例如 v1-1-46-provider-notice" />
        </label>
        <label>标题
          <input id="title" required placeholder="例如：图片模型临时维护" />
        </label>
        <label>正文
          <textarea id="content" required placeholder="写给用户看的公告内容，尽量少技术黑话。"></textarea>
        </label>
        <label>平台
          <div class="checks">
            <label><input type="checkbox" value="win32" name="platform" /> Windows</label>
            <label><input type="checkbox" value="darwin" name="platform" /> macOS</label>
            <label><input type="checkbox" value="linux" name="platform" /> Linux</label>
          </div>
        </label>
        <div class="row">
          <label>最低版本
            <input id="minAppVersion" placeholder="1.1.46" />
          </label>
          <label>最高版本
            <input id="maxAppVersion" placeholder="1.1.50" />
          </label>
        </div>
        <div class="row">
          <label>开始时间
            <input id="startsAt" type="datetime-local" />
          </label>
          <label>结束时间
            <input id="endsAt" type="datetime-local" />
          </label>
        </div>
        <div class="actions">
          <button class="primary" id="saveButton" type="submit">保存公告</button>
          <button type="button" onclick="resetForm()">清空表单</button>
        </div>
      </form>
    </section>
    <section class="card list" id="list"></section>
  </main>
  <div class="toast" id="toast"></div>
  <script>
    let payload = { version: 1, updatedAt: new Date().toISOString(), items: [] }
    const el = (id) => document.getElementById(id)
    const toast = (text) => {
      el('toast').textContent = text
      el('toast').classList.add('show')
      setTimeout(() => el('toast').classList.remove('show'), 2800)
    }
    const setStatus = (text, type = 'success') => {
      el('status').textContent = text
      el('status').className = 'status show' + (type === 'error' ? ' error' : '')
    }
    const toLocalInput = (value) => {
      if (!value) return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      const offset = date.getTimezoneOffset()
      const local = new Date(date.getTime() - offset * 60000)
      return local.toISOString().slice(0, 16)
    }
    const fromLocalInput = (value) => value ? new Date(value).toISOString() : ''
    async function api(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || '请求失败')
      return data
    }
    async function loadPayload() {
      try {
        payload = await api('/api/payload')
        renderList()
      } catch (error) {
        console.error(error)
        setStatus(error.message || '加载失败', 'error')
        toast(error.message || '加载失败')
      }
    }
    function renderList() {
      const list = el('list')
      if (!payload.items.length) {
        list.innerHTML = '<div class="empty">还没有公告，左侧新增一条吧。</div>'
        return
      }
      const activeUrgentCount = payload.items.filter((item) => item.type === 'urgent' && getVisibilityState(item).key === 'visible').length
      const urgentNote = activeUrgentCount > 1
        ? '<div class="list-note">当前有 ' + activeUrgentCount + ' 条紧急信息处于展示中。客户端只会展示优先级最高的一条，建议关闭暂不需要的紧急信息。</div>'
        : ''
      list.innerHTML = urgentNote + payload.items.map((item) => {
        const badgeClass = item.type === 'urgent' ? 'badge urgent' : 'badge'
        const typeText = item.type === 'urgent' ? '紧急信息' : '普通公告'
        const visibility = getVisibilityState(item)
        const platforms = item.platforms?.length ? item.platforms.join(', ') : '全部平台'
        const versions = [item.minAppVersion && '≥ ' + item.minAppVersion, item.maxAppVersion && '≤ ' + item.maxAppVersion].filter(Boolean).join('，') || '全部版本'
        return '<article class="item ' + (!item.enabled ? 'disabled' : '') + '">' +
          '<div class="item-top"><div><div class="title">' + escapeHtml(item.title) + '</div>' +
          '<div class="meta"><span>' + escapeHtml(item.id) + '</span><span>' + platforms + '</span><span>' + versions + '</span></div></div>' +
          '<span class="' + badgeClass + '">' + typeText + ' / ' + visibility.label + '</span></div>' +
          '<div class="content">' + escapeHtml(item.content) + '</div>' +
          '<div class="meta"><span>开始：' + formatDateTime(item.startsAt) + '</span><span>结束：' + formatDateTime(item.endsAt) + '</span><span>' + visibility.description + '</span></div>' +
          '<div class="actions" style="margin-top:12px">' +
          '<button data-action="edit" data-id="' + escapeHtml(item.id) + '">编辑</button>' +
          '<button data-action="toggle" data-id="' + escapeHtml(item.id) + '" data-enabled="' + String(!item.enabled) + '">' + (item.enabled ? '关闭' : '启用') + '</button>' +
          '<button class="danger" data-action="remove" data-id="' + escapeHtml(item.id) + '">删除</button>' +
          '</div></article>'
      }).join('')
    }
    function formatDateTime(value) {
      if (!value) return '-'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      return date.toLocaleString()
    }
    function getVisibilityState(item) {
      if (!item.enabled) {
        return { key: 'closed', label: '已关闭', description: '已手动关闭，客户端不会展示。' }
      }

      const now = Date.now()
      const startsAt = item.startsAt ? new Date(item.startsAt).getTime() : 0
      const endsAt = item.endsAt ? new Date(item.endsAt).getTime() : 0

      if (startsAt && startsAt > now) {
        return { key: 'pending', label: '待发布', description: '未到开始时间，客户端暂不展示。' }
      }

      if (endsAt && endsAt < now) {
        return { key: 'ended', label: '已结束展示', description: '已超过结束时间，客户端会自动过滤不展示。' }
      }

      return { key: 'visible', label: '展示中', description: '当前符合展示条件，客户端会在轮询后展示。' }
    }
    function escapeHtml(text) {
      return String(text || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
    }
    function resetForm() {
      el('form').reset()
      el('originalId').value = ''
      document.querySelectorAll('[name=platform]').forEach((input) => { input.checked = false })
    }
    function editItem(id) {
      const item = payload.items.find((item) => item.id === id)
      if (!item) return
      el('originalId').value = item.id
      el('id').value = item.id
      el('type').value = item.type
      el('title').value = item.title || ''
      el('content').value = item.content || ''
      el('priority').value = item.priority ?? ''
      el('minAppVersion').value = item.minAppVersion || ''
      el('maxAppVersion').value = item.maxAppVersion || ''
      el('startsAt').value = toLocalInput(item.startsAt)
      el('endsAt').value = toLocalInput(item.endsAt)
      document.querySelectorAll('[name=platform]').forEach((input) => { input.checked = item.platforms?.includes(input.value) || false })
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
    function collectItem() {
      const platforms = Array.from(document.querySelectorAll('[name=platform]:checked')).map((input) => input.value)
      const priority = el('priority').value ? Number(el('priority').value) : undefined
      return {
        originalId: el('originalId').value.trim(),
        id: el('id').value.trim(),
        type: el('type').value,
        enabled: true,
        title: el('title').value.trim(),
        content: el('content').value.trim(),
        priority,
        platforms: platforms.length ? platforms : undefined,
        minAppVersion: el('minAppVersion').value.trim() || undefined,
        maxAppVersion: el('maxAppVersion').value.trim() || undefined,
        startsAt: fromLocalInput(el('startsAt').value),
        endsAt: fromLocalInput(el('endsAt').value)
      }
    }
    async function toggleItem(id, enabled) {
      try {
        await api('/api/item/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ enabled }) })
        toast(enabled ? '已启用' : '已关闭')
        await loadPayload()
      } catch (error) {
        console.error(error)
        setStatus(error.message || '操作失败', 'error')
        toast(error.message || '操作失败')
      }
    }
    async function removeItem(id) {
      if (!confirm('确定删除这条公告吗？如果只是下线，更建议点击“关闭”。')) return
      try {
        await api('/api/item/' + encodeURIComponent(id), { method: 'DELETE' })
        toast('已删除')
        await loadPayload()
      } catch (error) {
        console.error(error)
        setStatus(error.message || '删除失败', 'error')
        toast(error.message || '删除失败')
      }
    }
    el('form').addEventListener('submit', async (event) => {
      event.preventDefault()
      const submitButton = el('saveButton')
      submitButton.disabled = true
      setStatus('正在保存公告...', 'success')
      try {
        await api('/api/item', { method: 'POST', body: JSON.stringify(collectItem()) })
        setStatus('已保存。客户端最多 5 分钟内刷新公告。', 'success')
        toast('已保存，客户端最多 5 分钟内刷新')
        resetForm()
        await loadPayload()
      } catch (error) {
        console.error(error)
        setStatus(error.message || '保存失败', 'error')
        toast(error.message || '保存失败')
      } finally {
        submitButton.disabled = false
      }
    })
    el('list').addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-action]')
      if (!button) return

      const id = button.dataset.id
      if (!id) return

      if (button.dataset.action === 'edit') {
        editItem(id)
        return
      }

      if (button.dataset.action === 'toggle') {
        await toggleItem(id, button.dataset.enabled === 'true')
        return
      }

      if (button.dataset.action === 'remove') {
        await removeItem(id)
      }
    })
    loadPayload()
  </script>
</body>
</html>`

const handleApi = async (req, res, pathname) => {
  if (pathname === '/api/payload' && req.method === 'GET') {
    return send(res, 200, readPayload())
  }

  if (pathname === '/api/item' && req.method === 'POST') {
    const result = upsertItem(await readBody(req))
    return send(res, 200, result)
  }

  const itemMatch = pathname.match(/^\/api\/item\/(.+)$/)
  if (itemMatch && req.method === 'PATCH') {
    const id = decodeURIComponent(itemMatch[1])
    const result = patchItem(id, await readBody(req))
    return send(res, 200, result)
  }

  if (itemMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(itemMatch[1])
    const result = deleteItem(id)
    return send(res, 200, result)
  }

  return send(res, 404, { error: 'Not found' })
}

const server = http.createServer(async (req, res) => {
  try {
    if (!requireAuth(req, res)) return

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url.pathname)
    }

    return send(res, 200, html, 'text/html; charset=utf-8')
  } catch (error) {
    return send(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
})

if (process.argv.includes('--check')) {
  const payload = readPayload()
  console.log(`OK: ${config.file}`)
  console.log(`Items: ${payload.items.length}`)
  process.exit(0)
}

if (!config.password && process.env.ANNOUNCEMENT_MANAGER_ALLOW_NO_PASSWORD !== 'true') {
  console.error('Missing ANNOUNCEMENT_MANAGER_PASSWORD. Set it before starting the manager.')
  process.exit(1)
}

server.listen(config.port, config.host, () => {
  console.log(`Announcement manager: http://${config.host}:${config.port}`)
  console.log(`Announcement file: ${config.file}`)
})
