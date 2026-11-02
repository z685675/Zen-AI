import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { shortDirectory } from './fixtures/windows-path'

const run = promisify(execFile)
const quote = (value: string) => value.replaceAll("'", "''")
const hasExited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null

async function waitForExit(child: ChildProcess) {
  if (!hasExited(child)) await once(child, 'exit', { signal: AbortSignal.timeout(5000) })
}

describe('installer fixture exit observation', () => {
  it.each(['code', 'signal'])('waits for a deferred %s exit and recognizes it on subsequent checks', async (kind) => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null
    }) as ChildProcess
    let observed = false
    const waiting = waitForExit(child).then(() => {
      observed = true
    })
    await Promise.resolve()
    expect(observed).toBe(false)
    Object.assign(child, kind === 'code' ? { exitCode: 0 } : { signalCode: 'SIGTERM' })
    child.emit('exit', child.exitCode, child.signalCode)
    await waiting
    expect(observed).toBe(true)
    await waitForExit(child)
    expect(child.listenerCount('exit')).toBe(0)
  })
})

// Use real 64-bit fixture processes, including a sibling path that must survive.
// The PowerShell wrappers restrict enumeration and termination to these fixtures;
// the installer script must never touch the user's running application in tests.
describe.skipIf(process.platform !== 'win32' || process.arch !== 'x64')('installer PowerShell bitness', () => {
  it.each([
    { system: 'SysWOW64', shortPath: false },
    { system: 'System32', shortPath: false },
    { system: 'SysWOW64', shortPath: true },
    { system: 'System32', shortPath: true }
  ])(
    'closes a 64-bit fixture from $system (short path: $shortPath) without touching its sibling',
    async ({ system, shortPath }) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'zen-installer-bitness-'))
      const children: ChildProcess[] = []
      try {
        const fixtureRoot = shortPath ? await shortDirectory(directory) : directory
        const targetRoot = path.join(fixtureRoot, 'Zen AI')
        const siblingRoot = path.join(fixtureRoot, 'Zen AI-other')
        for (const root of [targetRoot, siblingRoot]) {
          await mkdir(root)
          const executable = path.join(root, 'helper.exe')
          await copyFile(path.join(process.env.WINDIR!, 'System32', 'cmd.exe'), executable)
          const child = spawn(executable, ['/d', '/q', '/k'], { windowsHide: true, stdio: 'pipe' })
          children.push(child)
          await once(child, 'spawn')
        }
        const [target, sibling] = children
        const result = await run(
          path.join(process.env.WINDIR!, system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `
          $ErrorActionPreference = 'Stop'
          function Get-CimInstance {
            param([string]$ClassName, [string]$Filter)
            $options = @{ClassName=$ClassName}
            if ($Filter) {$options.Filter=$Filter}
            CimCmdlets\\Get-CimInstance @options | Where-Object { $_.ProcessId -in @(${target.pid}, ${sibling.pid}) }
          }
          function Stop-Process {
            param([int]$Id, [switch]$Force)
            if ($Id -ne ${target.pid}) {throw 'Refusing to stop a process outside this test fixture'}
            Microsoft.PowerShell.Management\\Stop-Process -Id $Id -Force
          }
          if ([IntPtr]::Size -eq 4) {
            if ((Get-Process -Id ${target.pid}).Path) {throw 'Expected the cross-bitness Path limitation'}
            Write-Output 'PATH_UNAVAILABLE_REPRODUCED'
          }
          . '${quote(path.resolve('build/close-running-app.ps1'))}' -InstallDirectory '${quote(targetRoot)}' -GracePeriodSeconds 0
          if (-not (Get-Process -Id ${sibling.pid} -ErrorAction Stop)) {throw 'Sibling process was closed'}
          Write-Output 'PASS_REAL_SCOPED_CLEANUP'
          `
          ],
          { encoding: 'utf8', windowsHide: true, timeout: 15000 }
        )
        if (system === 'SysWOW64') expect(result.stdout).toContain('PATH_UNAVAILABLE_REPRODUCED')
        expect(result.stdout).toContain('PASS_REAL_SCOPED_CLEANUP')
        // OS termination and Node's exit event are not delivered in lockstep.
        // Signal exits legitimately keep exitCode null, including on Windows CI.
        await waitForExit(target)
        expect(hasExited(target)).toBe(true)
        expect(hasExited(sibling)).toBe(false)
      } finally {
        await Promise.all(
          children.map(async (child) => {
            if (!hasExited(child)) {
              const exited = waitForExit(child)
              child.kill()
              await exited
            }
          })
        )
        await rm(directory, { recursive: true, force: true })
      }
    }
  )
})
