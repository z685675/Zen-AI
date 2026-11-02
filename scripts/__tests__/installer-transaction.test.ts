import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { shortDirectory } from './fixtures/windows-path'

const run = promisify(execFile)
const quote = (value: string) => value.replaceAll("'", "''")
const compiler = path.join(
  process.env.LOCALAPPDATA ?? '',
  'electron-builder/Cache/nsis/nsis-3.0.4.1-nsis-3.0.4.1/Bin/makensis.exe'
)

// Real filesystem and registry operations, confined to a temporary directory and
// a unique HKCU test key. No real application installation is modified.
describe.skipIf(process.platform !== 'win32')('Windows installation recovery', () => {
  it.each(['directory', 'scope', 'legacy-unquoted', 'mismatched-uninstaller', 'interrupted-migration'])(
    'blocks an unsafe %s change before touching the old installation',
    async (scenario) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'zen-install-guard-'))
      try {
        const { stdout } = await run(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            String.raw`
          $ErrorActionPreference = 'Stop'
          $fixtureRoot = '${quote(directory)}'
          $old = Join-Path $fixtureRoot 'old installation'
          $target = if ('${scenario}' -eq 'scope') { $old } else { Join-Path $fixtureRoot 'new installation' }
          $keyRoot = 'Software\ZenAIInstallerTests\${path.basename(directory)}'
          $installKey = "$keyRoot\install"
          $uninstallKey = "$keyRoot\uninstall"
          $legacyKey = "$keyRoot\legacy"
          function Check($condition, $message) { if (-not $condition) { throw $message } }
          try {
            New-Item -ItemType Directory -Path $old -Force | Out-Null
            Set-Content -LiteralPath "$old\Zen AI.exe" -Value 'OLD'
            Set-Content -LiteralPath "$old\Uninstall Zen AI.exe" -Value 'old uninstaller'
            $registeredKey = if ('${scenario}' -eq 'legacy-unquoted') { $legacyKey } else { $uninstallKey }
            New-Item -Path "HKCU:\$registeredKey" -Force | Out-Null
            $command = if ('${scenario}' -eq 'legacy-unquoted') { "$old\Uninstall Zen AI.exe /S" } else { '"'+$old+'\Uninstall Zen AI.exe" /S' }
            New-ItemProperty -Path "HKCU:\$registeredKey" -Name UninstallString -Value $command | Out-Null
            if ('${scenario}' -ne 'legacy-unquoted') {
              New-Item -Path "HKCU:\$installKey" -Force | Out-Null
              $location = if ('${scenario}' -eq 'mismatched-uninstaller') { $target } else { $old }
              New-ItemProperty -Path "HKCU:\$installKey" -Name InstallLocation -Value $location | Out-Null
            }
            $originalExecutable = "$old\Zen AI.exe"
            if ('${scenario}' -eq 'interrupted-migration') {
              & '${quote(path.resolve('build/install-transaction.ps1'))}' -Action Prepare -InstallDirectory $old -InstallRegistryKey $installKey -UninstallRegistryKey $uninstallKey -LegacyUninstallRegistryKey $legacyKey
              $originalExecutable = "$old.zen-ai-previous\Zen AI.exe"
              $command = ''
            }
            $mode = if ('${scenario}' -eq 'scope') { 'all' } else { 'CurrentUser' }
            $failure = ''
            try {
              & '${quote(path.resolve('build/install-transaction.ps1'))}' -Action Prepare -InstallDirectory $target -InstallRegistryKey $installKey -UninstallRegistryKey $uninstallKey -LegacyUninstallRegistryKey $legacyKey -InstallMode $mode -Language 2052
            } catch { $failure = $_.Exception.Message }
            Check ($failure -match '原安装目录和原安装范围') 'Migration was not blocked with a localized recovery instruction'
            Check ((Get-Content -LiteralPath $originalExecutable) -eq 'OLD') 'Old executable changed'
            Check ([string](Get-ItemProperty -LiteralPath "HKCU:\$registeredKey").UninstallString -eq $command) 'Old uninstaller registration changed'
            Check (-not (Test-Path -LiteralPath "$target.zen-ai-update.json")) 'A transaction started before validation'
            Check (-not (Test-Path -LiteralPath "$target.zen-ai-previous")) 'Old installation moved before validation'
            Write-Output 'PASS_UPGRADE_GUARD'
          } finally {
            Remove-Item -LiteralPath "HKCU:\$keyRoot" -Recurse -Force -ErrorAction SilentlyContinue
          }
        `
          ],
          { encoding: 'utf8', windowsHide: true, timeout: 20000 }
        )
        expect(stdout).toContain('PASS_UPGRADE_GUARD')
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it('removes newly created product registry entries when an unregistered installation rolls back', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zen-install-registry-'))
    try {
      const { stdout } = await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          String.raw`
        $ErrorActionPreference = 'Stop'
        $target = '${quote(path.join(directory, 'Zen AI'))}'
        $keyRoot = 'Software\ZenAIInstallerTests\${path.basename(directory)}'
        $options = @{InstallDirectory=$target; InstallRegistryKey="$keyRoot\install"; UninstallRegistryKey="$keyRoot\uninstall"}
        try {
          New-Item -ItemType Directory -Path $target | Out-Null
          Set-Content -LiteralPath "$target\Zen AI.exe" -Value 'OLD'
          & '${quote(path.resolve('build/install-transaction.ps1'))}' @options -Action Prepare
          foreach ($name in @('install', 'uninstall')) {
            New-Item -Path "HKCU:\$keyRoot\$name" -Force | Out-Null
            New-ItemProperty -Path "HKCU:\$keyRoot\$name" -Name DisplayVersion -Value 'partial' | Out-Null
          }
          & '${quote(path.resolve('build/install-transaction.ps1'))}' @options -Action Rollback
          if ((Get-Content -LiteralPath "$target\Zen AI.exe") -ne 'OLD') { throw 'Old files were not restored' }
          if (Test-Path -LiteralPath "HKCU:\$keyRoot\install") { throw 'Partial install metadata survived rollback' }
          if (Test-Path -LiteralPath "HKCU:\$keyRoot\uninstall") { throw 'Partial uninstall metadata survived rollback' }
          Write-Output 'PASS_REGISTRY_ROLLBACK'
        } finally {
          Remove-Item -LiteralPath "HKCU:\$keyRoot" -Recurse -Force -ErrorAction SilentlyContinue
        }
      `
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 20000 }
      )
      expect(stdout).toContain('PASS_REGISTRY_ROLLBACK')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each(['Zen AI', '中文用户/中文目录/Zen AI', 'short-path/Zen AI'])(
    'restores files and registry, commits and recovers interruptions in %s',
    async (installName) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'zen-install-transaction-'))
      try {
        const fixtureRoot = installName.startsWith('short-path/') ? await shortDirectory(directory) : directory
        const { stdout } = await run(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            String.raw`
        $ErrorActionPreference = 'Stop'
        $target = '${quote(path.join(fixtureRoot, installName))}'
        $backup = "$target.zen-ai-previous"
        $keyRoot = '${'Software\\ZenAIInstallerTests\\' + path.basename(directory)}'
        $installKey = "$keyRoot\install"
        $uninstallKey = "$keyRoot\uninstall"
        $options = @{InstallDirectory=$target; InstallRegistryKey=$installKey; UninstallRegistryKey=$uninstallKey}
        function Transaction($action) { & '${quote(path.resolve('build/install-transaction.ps1'))}' @options -Action $action }
        function Check($condition, $message) { if (-not $condition) {throw $message} }
        try {
          New-Item -ItemType Directory -Path "$target\resources" -Force | Out-Null
          Set-Content -LiteralPath "$target\Zen AI.exe" -Value 'OLD'
          Set-Content -LiteralPath "$target\resources\old-only.txt" -Value 'old resource'
          New-Item -Path "HKCU:\$installKey" -Force | Out-Null
          New-ItemProperty -Path "HKCU:\$installKey" -Name InstallLocation -Value $target | Out-Null
          New-Item -Path "HKCU:\$uninstallKey" -Force | Out-Null
          New-ItemProperty -Path "HKCU:\$uninstallKey" -Name UninstallString -Value ('"'+$target+'\Uninstall Zen AI.exe" /allusers') | Out-Null
          New-ItemProperty -Path "HKCU:\$uninstallKey" -Name DisplayVersion -Value 'old' | Out-Null
          New-ItemProperty -Path "HKCU:\$uninstallKey" -Name DisplayName -Value '中文应用名称' | Out-Null
          Transaction Prepare
          # Existing recovery records were UTF-8 without a BOM. Both those
          # records and newly written records must work under Windows PowerShell.
          $journalPath = "$target.zen-ai-update.json"
          [IO.File]::WriteAllText($journalPath, (Get-Content -LiteralPath $journalPath -Encoding UTF8 -Raw))
          Check ((Get-Content -LiteralPath "$backup\Zen AI.exe") -eq 'OLD') 'Old executable was lost before extraction'
          Check (-not (Get-ItemProperty -Path "HKCU:\$uninstallKey").UninstallString) 'Old uninstaller was not bypassed'
          Set-Content -LiteralPath "$target\partial.txt" -Value 'incomplete extraction'
          Set-ItemProperty -Path "HKCU:\$uninstallKey" -Name DisplayVersion -Value 'partial'
          Transaction Rollback
          Check ((Get-Content -LiteralPath "$target\Zen AI.exe") -eq 'OLD') 'Old executable not restored'
          Check (Test-Path -LiteralPath "$target\resources\old-only.txt") 'Old resources not restored'
          Check (-not (Test-Path -LiteralPath "$target\partial.txt")) 'Partial files survived rollback'
          Check ((Get-ItemProperty -Path "HKCU:\$uninstallKey").DisplayVersion -eq 'old') 'Old registry metadata not restored'
          Check ((Get-ItemProperty -Path "HKCU:\$uninstallKey").DisplayName -eq '中文应用名称') 'Unicode registry values were corrupted'
          Check ([bool](Get-ItemProperty -Path "HKCU:\$uninstallKey").UninstallString) 'Old uninstall entry not restored'
          Transaction Prepare
          Set-Content -LiteralPath "$target\Zen AI.exe" -Value 'NEW'
          Transaction Commit
          Check ((Get-Content -LiteralPath "$target\Zen AI.exe") -eq 'NEW') 'New version not committed'
          Check (-not (Test-Path -LiteralPath $backup)) 'Successful installation retained unnecessary backup'
          Check (-not (Test-Path -LiteralPath "$target.zen-ai-update.json")) 'Commit journal not removed'
          Check (-not (Test-Path -LiteralPath "$target\resources\old-only.txt")) 'Obsolete files survived successful replacement'
          # A crash has no callback. The next installer must recover first.
          Transaction Prepare
          Set-Content -LiteralPath "$target\partial.txt" -Value 'interrupted'
          Transaction Prepare
          Check ((Get-Content -LiteralPath "$backup\Zen AI.exe") -eq 'NEW') 'Interrupted installation did not recover before retry'
          Transaction Rollback
          Write-Output 'PASS_REAL_INSTALL_RECOVERY'
        } finally {
          Remove-Item -LiteralPath "HKCU:\$keyRoot" -Recurse -Force -ErrorAction SilentlyContinue
        }
      `
          ],
          { encoding: 'utf8', windowsHide: true, timeout: 20000 }
        )
        expect(stdout).toContain('PASS_REAL_INSTALL_RECOVERY')
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it.each(['foreign-backup', 'locked-executable', 'foreign-partial', 'invalid-journal', 'invalid-retained-journal'])(
    'preserves existing files on %s',
    async (scenario) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'zen-install-preserve-'))
      try {
        const { stdout } = await run(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            String.raw`
        $ErrorActionPreference = 'Stop'
        $target = '${quote(path.join(directory, 'Zen AI'))}'
        $backup = "$target.zen-ai-previous"
        $keyRoot = '${'Software\\ZenAIInstallerTests\\' + path.basename(directory)}'
        $options = @{InstallDirectory=$target; InstallRegistryKey="$keyRoot\install"; UninstallRegistryKey="$keyRoot\uninstall"}
        function Transaction($action) { & '${quote(path.resolve('build/install-transaction.ps1'))}' @options -Action $action }
        New-Item -ItemType Directory -Path $target | Out-Null
        Set-Content -LiteralPath "$target\Zen AI.exe" -Value 'OLD'
        $handle = $null
        try {
          switch ('${scenario}') {
            'foreign-backup' {
              New-Item -ItemType Directory -Path $backup | Out-Null
              Set-Content -LiteralPath "$backup\important.txt" -Value 'PRESERVE'
            }
            'locked-executable' { $handle = [IO.File]::Open("$target\Zen AI.exe", 'Open', 'Read', 'None') }
            'foreign-partial' {
              Transaction Prepare
              Remove-Item -LiteralPath "$target\.zen-ai-installing"
              Set-Content -LiteralPath "$target\important.txt" -Value 'PRESERVE'
            }
            'invalid-journal' { Set-Content -LiteralPath "$target.zen-ai-update.json" -Value '{"product":"other"}' }
            'invalid-retained-journal' {
              New-Item -ItemType Directory -Path $backup | Out-Null
              Set-Content -LiteralPath "$backup\important.txt" -Value 'PRESERVE'
              $outside = '${quote(path.join(directory, 'outside'))}'
              New-Item -ItemType Directory -Path $outside | Out-Null
              Set-Content -LiteralPath "$outside\important.txt" -Value 'PRESERVE'
              $id = [Guid]::NewGuid().ToString('N')
              $invalid = @{ product='Zen AI'; schema=1; id=$id; phase='committed'; target=$target; backup=$outside; installKey=$options.InstallRegistryKey; uninstallKey=$options.UninstallRegistryKey }
              [IO.File]::WriteAllText("$target.zen-ai-update.json.retained.$id", ($invalid | ConvertTo-Json))
            }
          }
          $rejected = $false
          try { Transaction Prepare } catch { $rejected = $true }
          if (-not $rejected) {throw 'Unsafe installation was allowed'}
          if ('${scenario}' -eq 'foreign-partial') {
            if ((Get-Content -LiteralPath "$target\important.txt") -ne 'PRESERVE') {throw 'Foreign files were deleted'}
            if ((Get-Content -LiteralPath "$backup\Zen AI.exe") -ne 'OLD') {throw 'Old version was lost'}
          } elseif (-not (Test-Path -LiteralPath "$target\Zen AI.exe")) {throw 'Existing version was deleted'}
          if ('${scenario}' -eq 'invalid-retained-journal' -and
              ((Get-Content -LiteralPath "$outside\important.txt") -ne 'PRESERVE' -or
               (Get-Content -LiteralPath "$backup\important.txt") -ne 'PRESERVE')) {throw 'Invalid cleanup scope was allowed'}
          Write-Output 'PASS_PRESERVED_EXISTING_FILES'
        } finally { if ($handle) {$handle.Close()} }
      `
          ],
          { encoding: 'utf8', windowsHide: true, timeout: 15000 }
        )
        expect(stdout).toContain('PASS_PRESERVED_EXISTING_FILES')
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it.each(['linked-backup', 'locked-backup', 'legacy-committed-journal'])(
    'continues upgrading after %s without losing recovery for the current update',
    async (scenario) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'zen-install-retained-'))
      try {
        const { stdout } = await run(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            String.raw`
          $ErrorActionPreference = 'Stop'
          $target = '${quote(path.join(directory, 'Zen AI'))}'
          $backup = "$target.zen-ai-previous"
          $journalPath = "$target.zen-ai-update.json"
          $keyRoot = '${'Software\\ZenAIInstallerTests\\' + path.basename(directory)}'
          $options = @{InstallDirectory=$target; InstallRegistryKey="$keyRoot\install"; UninstallRegistryKey="$keyRoot\uninstall"}
          function Transaction($action) { & '${quote(path.resolve('build/install-transaction.ps1'))}' @options -Action $action }
          function Check($condition, $message) { if (-not $condition) {throw $message} }
          $handle = $null
          try {
            New-Item -ItemType Directory -Path $target | Out-Null
            Set-Content -LiteralPath "$target\Zen AI.exe" -Value 'OLD'
            Transaction Prepare
            $first = Get-Content -LiteralPath $journalPath -Encoding UTF8 -Raw | ConvertFrom-Json
            $retained = "$journalPath.retained.$($first.id)"
            $outside = '${quote(path.join(directory, 'outside'))}'
            New-Item -ItemType Directory -Path $outside | Out-Null
            Set-Content -LiteralPath "$outside\important.txt" -Value 'PRESERVE'
            if ('${scenario}' -eq 'locked-backup') {
              $handle = [IO.File]::Open("$backup\Zen AI.exe", 'Open', 'Read', 'None')
            } else {
              New-Item -ItemType Junction -Path "$backup\link" -Target $outside | Out-Null
            }
            Set-Content -LiteralPath "$target\Zen AI.exe" -Value 'NEW'
            if ('${scenario}' -eq 'legacy-committed-journal') {
              # Emulate an older installer stopping after commit and before cleanup.
              $first.phase = 'committed'
              [IO.File]::WriteAllText($journalPath, ($first | ConvertTo-Json -Depth 20))
            } else {
              Transaction Commit
              Check (Test-Path -LiteralPath $retained) 'Failed cleanup lost its ownership record'
              Check (-not (Test-Path -LiteralPath $journalPath)) 'Failed cleanup still blocks the active journal'
            }
            Transaction Prepare
            $second = Get-Content -LiteralPath $journalPath -Encoding UTF8 -Raw | ConvertFrom-Json
            Check ($second.backup -ne $backup) 'New installation reused a retained backup path'
            Check ((Get-Content -LiteralPath (Join-Path $second.backup 'Zen AI.exe')) -eq 'NEW') 'Current version not backed up'
            Set-Content -LiteralPath "$target\partial.txt" -Value 'FAILED NEXT UPDATE'
            Transaction Rollback
            Check ((Get-Content -LiteralPath "$target\Zen AI.exe") -eq 'NEW') 'Rollback restored the obsolete version'
            Check (-not (Test-Path -LiteralPath "$target\partial.txt")) 'Partial next update survived rollback'
            Check (Test-Path -LiteralPath $retained) 'Retained backup record was lost during rollback'
            Check ((Get-Content -LiteralPath "$outside\important.txt") -eq 'PRESERVE') 'Cleanup followed a junction'
            if ($handle) { $handle.Close(); $handle = $null }
            else { [IO.Directory]::Delete("$backup\link") }
            # Once the obstruction is gone, the next installer retries cleanup.
            Transaction Prepare
            Check (-not (Test-Path -LiteralPath $retained)) 'Retained cleanup was never retried'
            Set-Content -LiteralPath "$target\Zen AI.exe" -Value 'NEWEST'
            Transaction Commit
            Check ((Get-Content -LiteralPath "$target\Zen AI.exe") -eq 'NEWEST') 'Next update could not finish'
            Write-Output 'PASS_NONBLOCKING_BACKUP_CLEANUP'
          } finally { if ($handle) {$handle.Close()} }
        `
          ],
          { encoding: 'utf8', windowsHide: true, timeout: 20000 }
        )
        expect(stdout).toContain('PASS_NONBLOCKING_BACKUP_CLEANUP')
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(!existsSync(compiler))('restores the old version through the compiled NSIS failure callback', async () => {
    // The release workflow installs this toolset before packaging. Keep ordinary
    // source-only installs usable; the real PowerShell tests above always run.
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zen-nsis-recovery-'))
    try {
      const source = path.join(directory, 'recovery.nsi')
      const executable = path.join(directory, 'recovery.exe')
      await writeFile(
        source,
        String.raw`
        Unicode true
        !include LogicLib.nsh
        !define BUILD_RESOURCES_DIR "${path.resolve('build')}"
        !define INSTALL_REGISTRY_KEY "${'Software\\ZenAIInstallerTests\\' + path.basename(directory)}\install"
        !define UNINSTALL_APP_KEY "ZenAIInstallerTest-${path.basename(directory)}"
        !include "${path.resolve('build/installer-transaction.nsh')}"
        Name "Zen Installer Recovery Fixture"
        RequestExecutionLevel user
        SilentInstall silent
        OutFile "${executable}"
        Section
          StrCpy $INSTDIR "$EXEDIR\installed"
          CreateDirectory "$INSTDIR"
          FileOpen $0 "$INSTDIR\Zen AI.exe" w
          FileWrite $0 "OLD_FIXTURE"
          FileClose $0
          StrCpy $ZenInstallTransactionActive "1"
          !insertmacro ZenRunInstallTransaction "Prepare"
          FileOpen $0 "$INSTDIR\partial.txt" w
          FileWrite $0 "SIMULATED_FAILED_EXTRACTION"
          FileClose $0
          Abort
        SectionEnd
      `
      )
      await run(compiler, ['/V2', source], { windowsHide: true, timeout: 15000 })
      await run(executable, [], { windowsHide: true, timeout: 15000 }).catch((error) => {
        // NSIS returns non-zero for the intentionally failed install.
        if (typeof error.code !== 'number') throw error
      })
      expect(await readFile(path.join(directory, 'installed/Zen AI.exe'), 'utf8')).toBe('OLD_FIXTURE')
      expect(
        await access(path.join(directory, 'installed/partial.txt')).then(
          () => true,
          () => false
        )
      ).toBe(false)
      expect(
        await access(path.join(directory, 'installed.zen-ai-previous')).then(
          () => true,
          () => false
        )
      ).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
