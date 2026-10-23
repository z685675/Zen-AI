import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runInNewContext } from 'node:vm'

import type { Page } from '@playwright/test'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  assertNativeWritePermission,
  createFileTaskPermissionGuard,
  createNativeWritePermissionGuard,
  type NativeWriteFixture,
  type NativeWritePermission
} from '../native-write-permission'

const fixture: NativeWriteFixture = {
  workspace: path.resolve('isolated-workspace'),
  source: path.resolve('isolated-workspace/source.json'),
  output: path.resolve('isolated-workspace/result.txt'),
  content: 'synthetic source'
}
const request = (): NativeWritePermission => ({
  requestId: 'only-request',
  toolCallId: 'session:write',
  toolName: 'edit',
  status: 'pending',
  input: { filepath: fixture.output },
  suggestions: []
})
const tool = () => ({
  toolCallId: 'session:write',
  tool: { name: 'write', type: 'provider' },
  arguments: { filePath: fixture.output }
})

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('strict native write fixture permission guard', () => {
  it('requires matching edit metadata and the exact native write target', () => {
    expect(() => assertNativeWritePermission(request(), tool(), fixture)).not.toThrow()
    const camelCase = request()
    camelCase.input = { filePath: fixture.output }
    expect(() => assertNativeWritePermission(camelCase, tool(), fixture)).not.toThrow()
  })

  it.each([
    { toolName: 'bash' },
    { toolName: 'external_directory' },
    { toolCallId: 'other-session:write' },
    { requestId: '' },
    { status: 'invoking' },
    { autoApprove: true },
    { suggestions: [{ type: 'addRules', rules: ['*'] }] },
    { input: { patterns: ['*'] } },
    { input: { filepath: fixture.source } },
    { input: { filepath: path.resolve('outside.txt') } },
    { input: { filepath: fixture.output, filePath: fixture.source } }
  ])('refuses unknown/broad/original permissions without approving (%j)', (update) => {
    expect(() => assertNativeWritePermission({ ...request(), ...update }, tool(), fixture)).toThrow()
  })

  it.each([
    { toolCallId: 'other-session:write' },
    { tool: { name: 'mcp__assistant__create_file', type: 'mcp' } },
    { tool: { name: 'edit', type: 'provider' } },
    { arguments: { filePath: fixture.source } },
    { arguments: {} }
  ])('refuses mismatched/MCP tool blocks (%j)', (update) => {
    expect(() => assertNativeWritePermission(request(), { ...tool(), ...update }, fixture)).toThrow()
  })

  it('refuses a fixture whose output aliases its source', () => {
    expect(() => assertNativeWritePermission(request(), tool(), { ...fixture, source: fixture.output })).toThrow(
      'original-file'
    )
  })

  it('refuses existing output and modified source before any UI access', async () => {
    const instance = await mkdtemp(path.join(os.tmpdir(), 'zen-native-permission-unit-'))
    roots.push(instance)
    const page = { evaluate: vi.fn() } as unknown as Page
    const workspace = path.join(instance, 'workspace')
    await mkdir(workspace)
    const files = {
      workspace,
      source: path.join(workspace, 'source.json'),
      output: path.join(workspace, 'new.txt'),
      content: 'original'
    }
    await writeFile(path.join(instance, '.quality-instance'), 'zen-quality-isolated-v1')
    await writeFile(files.source, files.content)
    await writeFile(files.output, 'do not overwrite')
    await expect(createNativeWritePermissionGuard(page, instance, files)).rejects.toThrow('overwrite')
    await writeFile(files.source, 'changed')
    await expect(createNativeWritePermissionGuard(page, instance, files)).rejects.toThrow('already changed')
    expect(page.evaluate).not.toHaveBeenCalled()
    expect(await readFile(files.output, 'utf8')).toBe('do not overwrite')
  })

  it('waits briefly for a late tool block, then still rejects an unsafe request without clicking', async () => {
    const instance = await mkdtemp(path.join(os.tmpdir(), 'zen-native-permission-unit-'))
    roots.push(instance)
    const workspace = path.join(instance, 'workspace')
    await mkdir(workspace)
    const files = {
      workspace,
      source: path.join(workspace, 'source.json'),
      output: path.join(workspace, 'new.txt'),
      content: 'original'
    }
    await writeFile(path.join(instance, '.quality-instance'), 'zen-quality-isolated-v1')
    await writeFile(files.source, files.content)
    const unsafe = { ...request(), input: { filepath: files.source } }
    const page = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ requests: [unsafe], tools: [] })
        .mockResolvedValueOnce({
          requests: [unsafe],
          tools: [{ ...tool(), arguments: { filePath: files.source } }]
        }),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn()
    }
    const guard = await createNativeWritePermissionGuard(page as unknown as Page, instance, files)
    await expect(guard.checkPermission()).rejects.toThrow('unrelated path/original-file')
    expect(page.waitForFunction).toHaveBeenCalledOnce()
    expect(page.waitForFunction.mock.calls[0][2]).toEqual({ timeout: 5000 })
    expect(page.locator).not.toHaveBeenCalled()
    expect(guard.approved).toEqual([])
    expect(await readFile(files.source, 'utf8')).toBe('original')
  })

  it.each(['pending-request', 'visible-card'] as const)(
    'never approves a replacement %s after validating the original card',
    async (replacement) => {
      const instance = await mkdtemp(path.join(os.tmpdir(), 'zen-native-permission-unit-'))
      roots.push(instance)
      const workspace = path.join(instance, 'workspace')
      await mkdir(workspace)
      const files = {
        workspace,
        source: path.join(workspace, 'source.json'),
        output: path.join(workspace, 'new.txt'),
        content: 'original'
      }
      await writeFile(path.join(instance, '.quality-instance'), 'zen-quality-isolated-v1')
      await writeFile(files.source, files.content)
      const original = { ...request(), input: { filepath: files.output } }
      const state = {
        requests: [original],
        tools: [{ ...tool(), arguments: { filePath: files.output } }]
      }
      const approve = vi.fn()
      const page = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce(state)
          .mockResolvedValue(
            replacement === 'pending-request'
              ? { ...state, requests: [{ ...original, requestId: 'replacement-request' }] }
              : state
          ),
        waitForFunction: vi.fn().mockResolvedValue(undefined),
        locator: vi.fn((selector: string) => {
          const card = {
            filter: () => card,
            count: async () => 1,
            getAttribute: async () => original.toolCallId,
            innerText: async () => files.output,
            getByRole: () => ({
              click: async () => {
                // The original DOM card disappears just before Playwright resolves the click.
                // A global locator would now target the only visible replacement card.
                if (selector.includes('[data-tool-call-id="session\\3a write"]'))
                  throw new Error('Original permission card disappeared')
                approve('other-session:unsafe')
              }
            })
          }
          return card
        })
      }
      const guard = await createNativeWritePermissionGuard(page as unknown as Page, instance, files)
      await expect(guard.checkPermission()).rejects.toThrow(
        replacement === 'pending-request'
          ? 'Permission changed before approval'
          : 'Original permission card disappeared'
      )
      expect(page.evaluate).toHaveBeenCalledTimes(2)
      expect(page.locator).toHaveBeenCalledWith('[data-tool-permission-card][data-tool-call-id="session\\3a write"]')
      expect(approve).not.toHaveBeenCalled()
      expect(guard.approved).toEqual([])
      expect(await readFile(files.source, 'utf8')).toBe('original')
    }
  )
})

describe('file-task native permission guard', () => {
  type State = {
    requests: NativeWritePermission[]
    tools: Array<{ toolCallId: string; tool: { name: string; type: string }; arguments: Record<string, unknown> }>
  }

  const setup = async (collapsed = false) => {
    const instance = await mkdtemp(path.join(os.tmpdir(), 'zen-filetask-permission-unit-'))
    roots.push(instance)
    const workspace = path.join(instance, 'workspace')
    await mkdir(workspace)
    const files: NativeWriteFixture = {
      workspace,
      source: path.join(workspace, 'source.json'),
      output: path.join(workspace, 'new.txt'),
      content: '{"values":[1,2,3]}'
    }
    await writeFile(path.join(instance, '.quality-instance'), 'zen-quality-isolated-v1')
    await writeFile(files.source, files.content)
    let state: State = {
      requests: [
        {
          ...request(),
          requestId: 'bash-request',
          toolCallId: 'session:bash',
          toolName: 'bash',
          input: { command: 'cat source.json' }
        }
      ],
      tools: [
        {
          toolCallId: 'session:bash',
          tool: { name: 'bash', type: 'provider' },
          arguments: { command: 'cat source.json' }
        }
      ]
    }
    // Execute the actual read/wait callbacks against a renderer-shaped store.
    // There is no IPC/API surface: authorization can only happen through the mocked UI buttons.
    const predicate = (callback: (argument?: unknown) => unknown, argument?: unknown) =>
      runInNewContext(`(${callback.toString()})(argument)`, {
        argument,
        window: {
          store: {
            getState: () => ({
              toolPermissions: {
                requests: Object.fromEntries(state.requests.map((entry) => [entry.requestId, entry]))
              },
              messageBlocks: {
                entities: Object.fromEntries(
                  state.tools.map((entry, index) => [index, { metadata: { rawMcpToolResponse: entry } }])
                )
              }
            })
          }
        },
        document: {
          querySelectorAll: () => [
            { dataset: { toolCallId: state.requests[0]?.toolCallId }, getClientRects: () => [{}] }
          ]
        }
      })
    let expanded = !collapsed
    const cancel = vi.fn(async () => {
      state.requests = []
    })
    const run = vi.fn(async () => {
      state.requests = []
    })
    const expand = vi.fn(async () => {
      expanded = true
    })
    const card = {
      filter: () => card,
      first: () => card,
      count: vi.fn(async () => (expanded ? 1 : 0)),
      getAttribute: vi.fn(async () => state.requests[0]?.toolCallId),
      innerText: vi.fn(async () => ''),
      waitFor: vi.fn(async () => {
        expect(expanded).toBe(true)
      }),
      getByRole: vi.fn((role: string, options: { name: RegExp }) => {
        expect(role).toBe('button')
        if (options.name.test('Cancel')) return { click: cancel }
        if (options.name.test('Run')) return { click: run }
        throw new Error('Unexpected permission button')
      })
    }
    const group = {
      getAttribute: vi.fn(async () => String(expanded)),
      locator: vi.fn((selector: string) => {
        expect(selector).toBe('.ant-collapse-expand-icon')
        return { click: expand }
      })
    }
    const header = {
      filter: () => header,
      count: vi.fn(async () => 1),
      getAttribute: vi.fn(async () => state.requests[0]?.toolCallId),
      innerText: vi.fn(async () => ''),
      locator: vi.fn((selector: string) => {
        expect(selector).toBe('xpath=ancestor::*[@aria-expanded][1]')
        return group
      })
    }
    const page = {
      evaluate: vi.fn(async (callback: (argument?: unknown) => unknown) => predicate(callback)),
      waitForFunction: vi.fn(async (callback: (argument?: unknown) => unknown, argument: unknown) => {
        if (!predicate(callback, argument)) throw new Error('Permission wait condition not met')
      }),
      locator: vi.fn((selector: string) => {
        if (selector.startsWith('[data-tool-permission-card]')) return card
        if (selector.startsWith('[data-tool-permission-header]')) return header
        throw new Error('Unexpected unscoped permission locator')
      })
    }
    return {
      instance,
      files,
      page,
      card,
      header,
      cancel,
      run,
      expand,
      predicate,
      state: () => structuredClone(state),
      setState: (next: State) => {
        state = structuredClone(next)
      },
      createGuard: () => createFileTaskPermissionGuard(page as unknown as Page, instance, files)
    }
  }

  it.each([false, true])(
    'denies bash once via its matching UI card without an output path (collapsed: %s)',
    async (collapsed) => {
      const test = await setup(collapsed)
      const guard = await test.createGuard()
      await guard.checkPermission()
      expect(test.cancel).toHaveBeenCalledExactlyOnceWith({ timeout: 5000 })
      expect(test.run).not.toHaveBeenCalled()
      expect(test.expand).toHaveBeenCalledTimes(collapsed ? 1 : 0)
      expect(test.page.locator).toHaveBeenCalledWith(
        '[data-tool-permission-card][data-tool-call-id="session\\3a bash"]'
      )
      expect(test.card.innerText).not.toHaveBeenCalled()
      expect(test.header.innerText).not.toHaveBeenCalled()
      expect(test.page.evaluate).toHaveBeenCalledTimes(2)
      expect(guard.approved).toEqual([])
      expect(guard.denied).toEqual([
        { requestId: 'bash-request', toolCallId: 'session:bash', toolName: 'bash', expandedFromHeader: collapsed }
      ])
      expect(await readFile(test.files.source, 'utf8')).toBe(test.files.content)
      await expect(readFile(test.files.output)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it('can approve only one exact fixture write after denying bash', async () => {
    const test = await setup()
    const guard = await test.createGuard()
    await guard.checkPermission()
    const writeState: State = {
      requests: [{ ...request(), requestId: 'write-request', input: { filepath: test.files.output } }],
      tools: [{ ...tool(), arguments: { filePath: test.files.output } }]
    }
    test.setState(writeState)
    test.card.innerText.mockResolvedValue(test.files.output)
    await guard.checkPermission()
    expect(test.run).toHaveBeenCalledExactlyOnceWith({ timeout: 5000 })
    expect(test.cancel).toHaveBeenCalledOnce()
    expect(guard.approved).toEqual([
      { requestId: 'write-request', toolCallId: 'session:write', output: test.files.output, expandedFromHeader: false }
    ])
    expect(guard.denied).toHaveLength(1)
    test.setState({ ...writeState, requests: [{ ...writeState.requests[0], requestId: 'another-write' }] })
    await expect(guard.checkPermission()).rejects.toThrow('Additional permission after once approval')
    expect(test.run).toHaveBeenCalledOnce()
    expect(guard.approved).toHaveLength(1)
    expect(await readFile(test.files.source, 'utf8')).toBe(test.files.content)
  })

  it.each(['original', 'outside', 'unknown-edit'] as const)(
    'cancels unsafe %s native edits instead of approving them',
    async (kind) => {
      const test = await setup()
      const target = kind === 'original' ? test.files.source : path.join(test.instance, 'outside.txt')
      test.setState({
        requests: [{ ...request(), input: kind === 'unknown-edit' ? {} : { filepath: target } }],
        tools: [
          {
            ...tool(),
            tool: { name: kind === 'unknown-edit' ? 'edit' : 'write', type: 'provider' },
            arguments: kind === 'unknown-edit' ? {} : { filePath: target }
          }
        ]
      })
      const guard = await test.createGuard()
      await guard.checkPermission()
      expect(test.cancel).toHaveBeenCalledOnce()
      expect(test.run).not.toHaveBeenCalled()
      expect(guard.approved).toEqual([])
      expect(guard.denied).toEqual([
        { requestId: 'only-request', toolCallId: 'session:write', toolName: 'edit', expandedFromHeader: false }
      ])
      expect(await readFile(test.files.source, 'utf8')).toBe(test.files.content)
    }
  )

  it('does not record a denial if clicking Cancel fails', async () => {
    const test = await setup()
    const guard = await test.createGuard()
    test.cancel.mockRejectedValueOnce(new Error('Cancel submission failed'))
    await expect(guard.checkPermission()).rejects.toThrow('Cancel submission failed')
    expect(guard.denied).toEqual([])
    expect(guard.approved).toEqual([])
    expect(test.run).not.toHaveBeenCalled()
    expect(test.page.waitForFunction).toHaveBeenCalledOnce() // Only the visible-card wait ran.
  })

  it.each(['submitting-deny', 'pending', 'invoking'])(
    'does not count a request still present as %s as a completed denial',
    async (status) => {
      const test = await setup()
      const guard = await test.createGuard()
      test.cancel.mockImplementationOnce(async () => {
        const state = test.state()
        state.requests[0].status = status
        test.setState(state)
      })
      await expect(guard.checkPermission()).rejects.toThrow('Permission wait condition not met')
      expect(test.cancel).toHaveBeenCalledOnce()
      expect(test.run).not.toHaveBeenCalled()
      expect(guard.denied).toEqual([])
      expect(guard.approved).toEqual([])
    }
  )

  it('waits for removal of the exact denied request before returning or recording a denial', async () => {
    const test = await setup()
    const guard = await test.createGuard()
    let removed!: () => void
    const removal = new Promise<void>((resolve) => {
      removed = resolve
    })
    test.cancel.mockImplementationOnce(async () => {})
    const wait = test.page.waitForFunction.getMockImplementation()!
    test.page.waitForFunction.mockImplementationOnce(wait).mockImplementationOnce(async (predicate, id) => {
      expect(id).toBe('bash-request')
      expect(test.predicate(predicate, id)).toBe(false)
      await removal
      expect(test.predicate(predicate, id)).toBe(true)
    })
    let finished = false
    const pending = guard.checkPermission().then(() => {
      finished = true
    })
    await expect.poll(() => test.page.waitForFunction.mock.calls.length).toBe(2)
    expect(finished).toBe(false)
    expect(guard.denied).toEqual([])
    test.setState({ ...test.state(), requests: [] })
    removed()
    await pending
    expect(finished).toBe(true)
    expect(guard.denied).toHaveLength(1)
    expect(test.run).not.toHaveBeenCalled()
  })

  it.each([
    'request-id',
    'tool-call-id',
    'tool-name',
    'extra-request',
    'removed-request',
    'missing-tool',
    'non-native'
  ])('clicks neither Cancel nor Run when %s changes before the decision', async (change) => {
    const test = await setup()
    const guard = await test.createGuard()
    const before = test.state()
    const after = test.state()
    if (change === 'request-id') after.requests[0].requestId = 'replacement'
    if (change === 'tool-call-id') after.requests[0].toolCallId = 'other-session:bash'
    if (change === 'tool-name') after.requests[0].toolName = 'edit'
    if (change === 'extra-request') after.requests.push({ ...after.requests[0], requestId: 'extra' })
    if (change === 'removed-request') after.requests = []
    if (change === 'missing-tool') after.tools = []
    if (change === 'non-native') after.tools[0].tool.type = 'mcp'
    test.page.evaluate.mockResolvedValueOnce(before).mockResolvedValueOnce(after)
    await expect(guard.checkPermission()).rejects.toThrow()
    expect(test.page.evaluate).toHaveBeenCalledTimes(2)
    expect(test.card.getByRole).not.toHaveBeenCalled()
    expect(test.cancel).not.toHaveBeenCalled()
    expect(test.run).not.toHaveBeenCalled()
    expect(guard.denied).toEqual([])
    expect(guard.approved).toEqual([])
  })

  it.each(['request-id', 'tool-call-id', 'extra-request'])(
    'does not touch UI when %s changes while waiting for the matching tool block',
    async (change) => {
      const test = await setup()
      const guard = await test.createGuard()
      const before = test.state()
      const after = test.state()
      before.tools = []
      if (change === 'request-id') after.requests[0].requestId = 'replacement'
      if (change === 'tool-call-id') after.requests[0].toolCallId = 'other-session:bash'
      if (change === 'extra-request') after.requests.push({ ...after.requests[0], requestId: 'extra' })
      test.page.evaluate.mockResolvedValueOnce(before).mockResolvedValueOnce(after)
      test.page.waitForFunction.mockResolvedValueOnce(undefined)
      await expect(guard.checkPermission()).rejects.toThrow()
      expect(test.page.locator).not.toHaveBeenCalled()
      expect(test.cancel).not.toHaveBeenCalled()
      expect(test.run).not.toHaveBeenCalled()
      expect(guard.denied).toEqual([])
    }
  )

  it('refuses a fourth unsupported permission without another click after three confirmed denials', async () => {
    const test = await setup()
    const guard = await test.createGuard()
    const state = test.state()
    for (let index = 1; index <= 4; index++) {
      const toolCallId = `session:bash-${index}`
      test.setState({
        requests: [{ ...state.requests[0], requestId: `bash-${index}`, toolCallId }],
        tools: [{ ...state.tools[0], toolCallId }]
      })
      if (index <= 3) await guard.checkPermission()
      else await expect(guard.checkPermission()).rejects.toThrow('Repeated unsupported permissions')
    }
    expect(test.cancel).toHaveBeenCalledTimes(3)
    expect(test.page.locator).toHaveBeenCalledTimes(3)
    expect(test.run).not.toHaveBeenCalled()
    expect(guard.approved).toEqual([])
    expect(guard.denied.map((entry) => entry.requestId)).toEqual(['bash-1', 'bash-2', 'bash-3'])
  })

  it('refuses an already modified source before reading the permission queue', async () => {
    const test = await setup()
    await writeFile(test.files.source, 'changed')
    await expect(test.createGuard()).rejects.toThrow('Original fixture already changed')
    expect(test.page.evaluate).not.toHaveBeenCalled()
    expect(test.page.locator).not.toHaveBeenCalled()
    expect(test.cancel).not.toHaveBeenCalled()
    expect(test.run).not.toHaveBeenCalled()
  })

  it.each(['bash', 'write'])('stops before clicking %s when the source changes after guard creation', async (kind) => {
    const test = await setup()
    if (kind === 'write') {
      test.setState({
        requests: [{ ...request(), input: { filepath: test.files.output } }],
        tools: [{ ...tool(), arguments: { filePath: test.files.output } }]
      })
      test.card.innerText.mockResolvedValue(test.files.output)
    }
    const guard = await test.createGuard()
    await writeFile(test.files.source, 'changed')
    await expect(guard.checkPermission()).rejects.toThrow('Original changed before approval')
    expect(test.card.getByRole).not.toHaveBeenCalled()
    expect(test.cancel).not.toHaveBeenCalled()
    expect(test.run).not.toHaveBeenCalled()
    expect(guard.denied).toEqual([])
    expect(guard.approved).toEqual([])
  })
})
