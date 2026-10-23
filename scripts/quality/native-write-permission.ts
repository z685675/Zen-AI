import assert from 'node:assert/strict'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

import type { Page } from '@playwright/test'

import { within } from './electron'

export interface NativeWriteFixture {
  workspace: string
  source: string
  output: string
  content: string
}

export interface NativeWritePermission {
  requestId: string
  toolCallId: string
  toolName: string
  status: string
  input: Record<string, unknown>
  suggestions: unknown[]
  autoApprove?: boolean
}

export function assertNativeWritePermission(
  request: NativeWritePermission,
  tool: { toolCallId?: string; tool?: { name?: string; type?: string }; arguments?: Record<string, unknown> },
  fixture: NativeWriteFixture
) {
  const output = path.resolve(fixture.output)
  assert.notEqual(output, path.resolve(fixture.source), 'Refuse original-file approval')
  within(fixture.workspace, output)
  assert.equal(request.status, 'pending')
  assert(!request.autoApprove, 'Refuse auto-approval flag')
  assert.equal(request.suggestions.length, 0, 'Refuse persistent permission suggestions')
  assert.equal(request.toolName, 'edit', 'Refuse a non-edit native permission')
  assert.equal(request.toolCallId, tool.toolCallId, 'Permission/tool ID mismatch')
  assert(request.toolCallId && request.requestId, 'Missing permission identity')
  assert.equal(tool.tool?.type, 'provider')
  assert.equal(tool.tool?.name, 'write', 'Refuse MCP/other native tools')
  const metadataPaths = [request.input.filepath, request.input.filePath].filter((value) => value !== undefined)
  assert(metadataPaths.length > 0, 'Missing exact native permission filename (patterns alone are insufficient)')
  for (const value of [...metadataPaths, tool.arguments?.filePath]) {
    assert.equal(typeof value, 'string', 'Missing exact write filename')
    assert.equal(path.resolve(value as string), output, 'Refuse unrelated path/original-file approval')
  }
}

/** Open only this tool's group when its detail card is collapsed; never click a header Run button. */
async function visibleNativePermissionCard(page: Page, request: NativeWritePermission, expectedPath?: string) {
  // IPC can update Redux before React mounts the matching header/detail card.
  await page.waitForFunction(
    (id) =>
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-tool-permission-card], [data-tool-permission-header]')
      ).some((element) => element.dataset.toolCallId === id && element.getClientRects().length > 0),
    request.toolCallId,
    { timeout: 5000 }
  )
  const toolCallId = request.toolCallId.replace(
    /[^a-zA-Z0-9_-]/gu,
    (value) => `\\${value.codePointAt(0)!.toString(16)} `
  )
  const identity = `[data-tool-call-id="${toolCallId}"]`
  const cards = page.locator(`[data-tool-permission-card]${identity}`).filter({ visible: true })
  let expandedFromHeader = false
  if (!(await cards.count())) {
    const header = page.locator(`[data-tool-permission-header]${identity}`).filter({ visible: true })
    assert.equal(await header.count(), 1, 'Missing/ambiguous permission header: manual review required')
    assert.equal(await header.getAttribute('data-tool-call-id'), request.toolCallId)
    if (expectedPath)
      assert(
        (await header.innerText()).includes(expectedPath),
        'Exact output path not visible in collapsed permission header'
      )
    const groupHeader = header.locator('xpath=ancestor::*[@aria-expanded][1]')
    if ((await groupHeader.getAttribute('aria-expanded')) === 'false') {
      await groupHeader.locator('.ant-collapse-expand-icon').click()
      expandedFromHeader = true
    }
    await cards.first().waitFor({ state: 'visible', timeout: 5000 })
  }
  assert.equal(await cards.count(), 1, 'Missing/ambiguous visible permission card: manual review required')
  assert.equal(await cards.getAttribute('data-tool-call-id'), request.toolCallId)
  if (expectedPath)
    assert((await cards.innerText()).includes(expectedPath), 'Exact output path not visible on approval card')
  return { card: cards, expandedFromHeader }
}

export async function visibleNativeWritePermissionCard(page: Page, request: NativeWritePermission, output: string) {
  return visibleNativePermissionCard(page, request, output)
}

/** One fixture, one native write approval, via its visible UI card. Never approves '*' or originals. */
export async function createNativeWritePermissionGuard(page: Page, instance: string, fixture: NativeWriteFixture) {
  return createFixturePermissionGuard(page, instance, fixture, false)
}

/** Outcome-based file acceptance may refuse shell access and let the model choose safer tools.
 * The native write approval contract remains unchanged; no general shell is ever approved. */
export async function createFileTaskPermissionGuard(page: Page, instance: string, fixture: NativeWriteFixture) {
  return createFixturePermissionGuard(page, instance, fixture, true)
}

async function createFixturePermissionGuard(
  page: Page,
  instance: string,
  fixture: NativeWriteFixture,
  denyUnsupported: boolean
) {
  const instanceRoot = await realpath(instance)
  assert.equal(await readFile(path.join(instanceRoot, '.quality-instance'), 'utf8'), 'zen-quality-isolated-v1')
  const workspace = await realpath(fixture.workspace)
  within(instanceRoot, workspace)
  within(workspace, await realpath(fixture.source))
  within(workspace, fixture.output)
  assert.equal(await realpath(path.dirname(fixture.output)), workspace, 'Output parent must be the fixture workspace')
  assert.notEqual(path.resolve(fixture.output), await realpath(fixture.source), 'Refuse source alias')
  const original = await lstat(fixture.source)
  assert(original.isFile() && !original.isSymbolicLink(), 'Source must be a regular fixture file')
  assert.equal(await readFile(fixture.source, 'utf8'), fixture.content, 'Original fixture already changed')
  await assert.rejects(lstat(fixture.output), { code: 'ENOENT' }, 'Refuse overwrite or symlink output')
  const approved: Array<{ requestId: string; toolCallId: string; output: string; expandedFromHeader: boolean }> = []
  const denied: Array<{ requestId: string; toolCallId: string; toolName: string; expandedFromHeader: boolean }> = []
  const checkPermission = async () => {
    const readState = () =>
      page.evaluate(() => {
        const store = (window as any).store.getState()
        return {
          requests: Object.values<NativeWritePermission>(store.toolPermissions.requests),
          tools: Object.values(store.messageBlocks.entities)
            .map((block: any) => block?.metadata?.rawMcpToolResponse)
            .filter(Boolean)
        }
      })
    let state = await readState()
    let pending = state.requests.filter((request) => request.status === 'pending')
    if (!pending.length) return
    assert.equal(pending.length, 1, 'Unexpected permissions: manual review required, nothing approved')
    let request = pending[0]
    let tool = state.tools.find((item: any) => item.toolCallId === request.toolCallId)
    if (!tool) {
      // Permission IPC and tool streaming use different transports; tolerate only
      // the matching block arriving late. Revalidate the entire pending queue afterwards.
      await page.waitForFunction(
        ({ requestId, toolCallId }) => {
          const state = (window as any).store.getState()
          const request = state.toolPermissions.requests[requestId]
          return (
            !request ||
            request.status !== 'pending' ||
            Object.values(state.messageBlocks.entities).some(
              (block: any) => block?.metadata?.rawMcpToolResponse?.toolCallId === toolCallId
            )
          )
        },
        { requestId: request.requestId, toolCallId: request.toolCallId },
        { timeout: 5000 }
      )
      state = await readState()
      pending = state.requests.filter((entry) => entry.status === 'pending')
      if (!pending.length) return
      assert.equal(pending.length, 1, 'Unexpected permissions during tool-block wait: manual review required')
      assert.equal(pending[0].requestId, request.requestId, 'Permission changed during tool-block wait')
      assert.equal(pending[0].toolCallId, request.toolCallId, 'Permission tool changed during tool-block wait')
      request = pending[0]
      tool = state.tools.find((item: any) => item.toolCallId === request.toolCallId)
    }
    assert(tool, 'Native permission has no matching UI tool block')
    assert(request.requestId && request.toolCallId, 'Missing permission identity')
    assert.equal(request.toolCallId, tool.toolCallId, 'Permission/tool ID mismatch')
    assert.equal(tool.tool?.type, 'provider', 'Refuse a mismatched native permission tool')
    let allowWrite = true
    try {
      assertNativeWritePermission(request, tool, fixture)
    } catch (error) {
      if (!denyUnsupported) throw error
      allowWrite = false
    }
    if (allowWrite)
      assert.equal(approved.length, 0, 'Additional permission after once approval: manual review required')
    else assert(denied.length < 3, 'Repeated unsupported permissions: manual review required, nothing approved')
    const { card, expandedFromHeader } = await visibleNativePermissionCard(
      page,
      request,
      allowWrite ? fixture.output : undefined
    )
    assert.equal(await readFile(fixture.source, 'utf8'), fixture.content, 'Original changed before approval')
    assert.equal(await realpath(path.dirname(fixture.output)), workspace)
    if (allowWrite)
      await assert.rejects(lstat(fixture.output), { code: 'ENOENT' }, 'Output created before explicit approval')
    // Rendering/expansion can wait. Revalidate the current queue and tool, never a stale snapshot.
    state = await readState()
    pending = state.requests.filter((entry) => entry.status === 'pending')
    assert.equal(pending.length, 1, 'Permission queue changed before approval')
    assert.equal(pending[0].requestId, request.requestId, 'Permission changed before approval')
    assert.equal(pending[0].toolCallId, request.toolCallId, 'Permission tool changed before approval')
    tool = state.tools.find((item: any) => item.toolCallId === request.toolCallId)
    assert(tool, 'Native permission lost its matching UI tool block before approval')
    assert.equal(tool.toolCallId, request.toolCallId, 'Permission/tool ID mismatch')
    assert.equal(tool.tool?.type, 'provider', 'Permission no longer matches a native tool')
    if (!allowWrite) {
      assert.equal(pending[0].toolName, request.toolName, 'Permission tool name changed before denial')
      await card.getByRole('button', { name: /^(取\s*消|Cancel)$/i }).click({ timeout: 5000 })
      // A submitting-deny state is not acknowledgement. A failed response must
      // not be reported as a denial or trigger an additional model request.
      await page.waitForFunction(
        (id) => !(window as any).store.getState().toolPermissions.requests[id],
        request.requestId,
        { timeout: 5000 }
      )
      denied.push({
        requestId: request.requestId,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        expandedFromHeader
      })
      return
    }
    assertNativeWritePermission(pending[0], tool, fixture)
    // Run is a once decision. Never open the dropdown or send updatedPermissions.
    await card.getByRole('button', { name: /^(运\s*行|Run)$/i }).click({ timeout: 5000 })
    approved.push({
      requestId: request.requestId,
      toolCallId: request.toolCallId,
      output: fixture.output,
      expandedFromHeader
    })
    await page.waitForFunction(
      (id) => {
        const request = (window as any).store.getState().toolPermissions.requests[id]
        return !request || request.status !== 'pending'
      },
      request.requestId,
      { timeout: 5000 }
    )
  }
  return { checkPermission, approved, denied }
}
