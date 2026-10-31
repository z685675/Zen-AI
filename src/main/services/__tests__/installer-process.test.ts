import { execFileSync } from 'node:child_process'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

// Exercise the real PowerShell script with process cmdlets replaced in an
// isolated child. Never enumerate or terminate the user's actual processes.
describe.skipIf(process.platform !== 'win32')('Windows installer process cleanup', () => {
  it('closes only processes inside the exact install roots and rechecks reused PIDs', () => {
    const script = path.join(process.cwd(), 'build/close-running-app.ps1').replaceAll("'", "''")
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `
      $script:stopped = @()
      $script:enumerations = 0
      function Get-CimInstance {
        $script:enumerations++
        if ($script:enumerations -gt 1) {return [pscustomobject]@{ProcessId=22;ExecutablePath='C:\\elsewhere\\unrelated.exe'}}
        @(
          [pscustomobject]@{ProcessId=21;ExecutablePath='C:\\mock\\Zen AI\\Zen AI.exe'},
          [pscustomobject]@{ProcessId=22;ExecutablePath='C:\\mock\\Zen AI\\helper.exe'},
          [pscustomobject]@{ProcessId=23;ExecutablePath='C:\\mock\\Zen AI-other\\unrelated.exe'},
          [pscustomobject]@{ProcessId=44;ExecutablePath='C:\\mock\\Zen AI\\installer.exe'}
        )
      }
      function Get-Process {
        param([int]$Id)
        $file = if ($Id -eq 21) {'C:\\mock\\Zen AI\\Zen AI.exe'} else {'C:\\elsewhere\\unrelated.exe'}
        $item = [pscustomobject]@{Id=$Id;Path=$file}
        $item | Add-Member ScriptMethod CloseMainWindow {return $true}
        $item | Add-Member ScriptMethod WaitForExit {param($timeout);return $false}
        return $item
      }
      function Stop-Process {param([int]$Id,[switch]$Force); $script:stopped += $Id}
      . '${script}' -InstallDirectory 'C:\\mock\\Zen AI' -InstallerPid 44 -GracePeriodSeconds 0
      if (($script:stopped -join ',') -ne '21') {throw ('Unexpected processes: '+($script:stopped -join ','))}
      Write-Output 'PASS_SCOPED_PROCESS_CLEANUP'
    `
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 }
    )
    expect(output).toContain('PASS_SCOPED_PROCESS_CLEANUP')
    expect(output).toContain('Checked 2 remaining application processes.')
  })

  it('fails before replacement when a scoped process cannot be closed', () => {
    const script = path.join(process.cwd(), 'build/close-running-app.ps1').replaceAll("'", "''")
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `
      function Get-CimInstance { [pscustomobject]@{ProcessId=21;ExecutablePath='C:\\mock\\Zen AI\\Zen AI.exe'} }
      function Get-Process {
        $item = [pscustomobject]@{Id=21;Path='C:\\mock\\Zen AI\\Zen AI.exe'}
        $item | Add-Member ScriptMethod CloseMainWindow {return $false}
        $item | Add-Member ScriptMethod WaitForExit {param($timeout);return $false}
        return $item
      }
      function Stop-Process {}
      try {
        . '${script}' -InstallDirectory 'C:\\mock\\Zen AI' -GracePeriodSeconds 0
      } catch {
        if ($_.Exception.Message -like '*still running*') {Write-Output 'PASS_BLOCKED_REPLACEMENT'; exit 0}
        throw
      }
      throw 'Cleanup incorrectly permitted replacement'
    `
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 }
    )
    expect(output).toContain('PASS_BLOCKED_REPLACEMENT')
  })
})
