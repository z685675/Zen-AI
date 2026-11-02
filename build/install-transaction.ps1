param(
  [Parameter(Mandatory = $true)][ValidateSet('Prepare', 'Commit', 'Rollback')][string]$Action,
  [Parameter(Mandatory = $true)][string]$InstallDirectory,
  [Parameter(Mandatory = $true)][string]$InstallRegistryKey,
  [Parameter(Mandatory = $true)][string]$UninstallRegistryKey,
  [ValidateSet('CurrentUser', 'all')][string]$InstallMode = 'CurrentUser',
  [string]$LegacyUninstallRegistryKey = '',
  [int]$Language = 1033
)

$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
if ($target -eq [IO.Path]::GetPathRoot($target).TrimEnd('\')) { throw 'An installation cannot replace a drive root.' }
$backup = "$target.zen-ai-previous"
$journalPath = "$target.zen-ai-update.json"
$markerName = '.zen-ai-installing'
$uninstallKeys = @($UninstallRegistryKey)
if ($LegacyUninstallRegistryKey) { $uninstallKeys += $LegacyUninstallRegistryKey }
$registryKeys = @($InstallRegistryKey) + $uninstallKeys
$installHive = if ($InstallMode -eq 'all') { 'LocalMachine' } else { 'CurrentUser' }

function Stop-ConflictingInstallation([string]$location) {
  switch ($Language) {
    2052 { throw "检测到旧版安装在 $location。为保护旧版，请使用原安装目录和原安装范围完成升级。需要迁移位置时，请先通过系统卸载旧版并保留个人数据，再安装到新位置。" }
    1028 { throw "偵測到舊版安裝於 $location。為保護舊版，請使用原安裝目錄和原安裝範圍完成升級。需要搬移位置時，請先透過系統解除安裝舊版並保留個人資料，再安裝至新位置。" }
    default { throw "An existing installation was found at $location. Upgrade using its original directory and user scope. To relocate, first uninstall the old application while keeping personal data, then install in the new location." }
  }
}

function Get-UninstallerPath([string]$command) {
  $executable = ''
  if ($command -match '^"([^"]+)"') { $executable = $Matches[1] }
  elseif ($command -match '^(.+?\.exe)(?:\s|$)') { $executable = $Matches[1] }
  if (-not $executable) { return '' }
  # Registry commands can contain 8.3 aliases. Use the same normalization as
  # InstallDirectory/InstallLocation before comparing their parent directory.
  try { return [IO.Path]::GetFullPath($executable) } catch { return '' }
}

function Assert-CompatibleInstallation {
  foreach ($hive in @('CurrentUser', 'LocalMachine')) {
    $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$hive, [Microsoft.Win32.RegistryView]::Default)
    try {
      $key = $root.OpenSubKey($InstallRegistryKey)
      $location = if ($key) { try { [string]$key.GetValue('InstallLocation') } finally { $key.Close() } } else { '' }
      foreach ($keyPath in $uninstallKeys) {
        $key = $root.OpenSubKey($keyPath)
        $uninstaller = ''
        $command = ''
        if ($key) {
          try {
            $command = [string]$key.GetValue('UninstallString')
            $uninstaller = Get-UninstallerPath $command
          } finally { $key.Close() }
        }
        if ($command -and -not $uninstaller -and ($hive -eq $installHive -or $InstallMode -eq 'all')) {
          Stop-ConflictingInstallation $(if ($location) { $location } else { $keyPath })
        }
        $installedAt = if ($location) { [IO.Path]::GetFullPath($location).TrimEnd('\') } elseif ($uninstaller) { [IO.Path]::GetDirectoryName($uninstaller) } else { '' }
        if (-not $installedAt) { continue }
        $active = (Test-Path -LiteralPath (Join-Path $installedAt 'Zen AI.exe') -PathType Leaf) -or
          ($uninstaller -and (Test-Path -LiteralPath $uninstaller -PathType Leaf)) -or
          (Test-Path -LiteralPath "$installedAt.zen-ai-update.json" -PathType Leaf)
        if (-not $active) { continue }
        # Current-user installs do not replace an unrelated all-user install.
        $relevant = $hive -eq $installHive -or $InstallMode -eq 'all' -or $installedAt -eq $target
        if ($relevant -and ($installedAt -ne $target -or $hive -ne $installHive -or
            ($uninstaller -and [IO.Path]::GetDirectoryName($uninstaller) -ne $target))) {
          Stop-ConflictingInstallation $installedAt
        }
      }
    } finally { $root.Close() }
  }
}

function Assert-PlainPath([string]$itemPath) {
  if ((Test-Path -LiteralPath $itemPath) -and ((Get-Item -LiteralPath $itemPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Refusing to replace a redirected path: $itemPath"
  }
}
Assert-PlainPath $target
Assert-PlainPath $journalPath

function Save-Journal($journal) {
  $temporaryPath = "$journalPath.tmp"
  Assert-PlainPath $temporaryPath
  [IO.File]::WriteAllText($temporaryPath, ($journal | ConvertTo-Json -Depth 20), [Text.Encoding]::UTF8)
  Move-Item -LiteralPath $temporaryPath -Destination $journalPath -Force
}

function Assert-JournalScope($journal) {
  if ($journal.product -ne 'Zen AI' -or $journal.schema -ne 1 -or $journal.target -ne $target -or
      ($journal.backup -ne $backup -and $journal.backup -ne "$backup.$($journal.id)") -or $journal.installKey -ne $InstallRegistryKey -or
      $journal.uninstallKey -ne $UninstallRegistryKey -or $journal.id -notmatch '^[a-f0-9]{32}$' -or
      $journal.phase -notin @('pending', 'committed')) {
    throw 'The installation recovery record does not match this installation. Existing files were preserved.'
  }
}

function Read-Journal([string]$recordPath = $journalPath) {
  if (-not (Test-Path -LiteralPath $recordPath)) { return $null }
  Assert-PlainPath $recordPath
  # Windows PowerShell defaults to the ANSI code page for files without a BOM.
  # Explicit UTF-8 also reads recovery records written by previous installers.
  $journal = Get-Content -LiteralPath $recordPath -Encoding UTF8 -Raw | ConvertFrom-Json
  Assert-JournalScope $journal
  return $journal
}

function Get-RegistrySnapshots {
  $snapshots = @()
  foreach ($hive in @($installHive)) {
    $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$hive, [Microsoft.Win32.RegistryView]::Default)
    try {
      $installKey = $root.OpenSubKey($InstallRegistryKey)
      $location = if ($installKey) { $installKey.GetValue('InstallLocation'); $installKey.Close() } else { $null }
      foreach ($keyPath in $registryKeys) {
        $key = $root.OpenSubKey($keyPath)
        if (-not $key) {
          $snapshots += [pscustomobject]@{ hive = $hive; path = $keyPath; existed = $false; values = @() }
          continue
        }
        try {
          # Never alter another user's or another directory's installation.
          $uninstall = [string]$key.GetValue('UninstallString')
          $owned = $location -and ([IO.Path]::GetFullPath($location).TrimEnd('\') -eq $target)
          $uninstaller = Get-UninstallerPath $uninstall
          if (-not $owned -and $uninstaller) {
            $owned = ([IO.Path]::GetDirectoryName($uninstaller) -eq $target)
          }
          if (-not $owned) { continue }
          $values = @($key.GetValueNames() | ForEach-Object {
            [pscustomobject]@{ name = $_; kind = [string]$key.GetValueKind($_); value = $key.GetValue($_, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
          })
          $snapshots += [pscustomobject]@{ hive = $hive; path = $keyPath; existed = $true; values = $values }
        } finally { $key.Close() }
      }
    } finally { $root.Close() }
  }
  return $snapshots
}

function Restore-Registry($journal) {
  foreach ($snapshot in $journal.registry) {
    if ($snapshot.hive -notin @('CurrentUser', 'LocalMachine') -or $snapshot.path -notin $registryKeys) {
      throw 'Invalid registry recovery scope.'
    }
    $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$($snapshot.hive), [Microsoft.Win32.RegistryView]::Default)
    try {
      if ($snapshot.existed -eq $false) {
        $root.DeleteSubKeyTree($snapshot.path, $false)
        continue
      }
      $key = $root.CreateSubKey($snapshot.path)
      try {
        foreach ($name in $key.GetValueNames()) { $key.DeleteValue($name, $false) }
        foreach ($value in $snapshot.values) {
          $data = $value.value
          switch ($value.kind) {
            'DWord' { $data = [int]$data }
            'QWord' { $data = [long]$data }
            'Binary' { $data = [byte[]]$data }
            'MultiString' { $data = [string[]]$data }
          }
          $key.SetValue($value.name, $data, [Microsoft.Win32.RegistryValueKind]::$($value.kind))
        }
      } finally { $key.Close() }
    } finally { $root.Close() }
  }
}

function Remove-OwnedDirectory([string]$directory, $journal) {
  # Delete only the selected directory or the exact sibling owned by this
  # validated transaction. Retained backups must never become rollback targets.
  Assert-JournalScope $journal
  if ($directory -ne $target -and $directory -ne $journal.backup) { throw 'Invalid cleanup scope.' }
  Assert-PlainPath $directory
  # Windows PowerShell's recursive removal can follow directory junctions.
  # Walk without following links and preserve the backup if one is encountered.
  $pending = New-Object 'System.Collections.Generic.Stack[string]'
  $pending.Push($directory)
  while ($pending.Count -gt 0) {
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($pending.Pop())) {
      $attributes = [IO.File]::GetAttributes($entry)
      if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing cleanup through a link: $entry" }
      if ($attributes -band [IO.FileAttributes]::Directory) { $pending.Push($entry) }
    }
  }
  Remove-Item -LiteralPath $directory -Recurse -Force
}

function Complete-Commit($journal) {
  if (Test-Path -LiteralPath $journal.backup) {
    try { Remove-OwnedDirectory $journal.backup $journal }
    catch {
      # The replacement already succeeded. Preserve a separate ownership record
      # for deferred cleanup instead of blocking every subsequent upgrade.
      $retainedPath = "$journalPath.retained.$($journal.id)"
      Assert-PlainPath $retainedPath
      if (Test-Path -LiteralPath $retainedPath) { throw 'A retained recovery record already exists. Existing files were preserved.' }
      Move-Item -LiteralPath $journalPath -Destination $retainedPath
      Write-Output 'The new version is installed. Previous files will be cleaned on a later installation.'
      return
    }
  }
  Remove-Item -LiteralPath $journalPath -Force
}

function Clear-RetainedBackups {
  $parent = [IO.Path]::GetDirectoryName($journalPath)
  $prefix = [IO.Path]::GetFileName($journalPath) + '.retained.'
  $ownedBackups = @()
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) { return }
  foreach ($record in Get-ChildItem -LiteralPath $parent -File -Force) {
    if ($record.Name -notmatch ('^' + [regex]::Escape($prefix) + '([a-f0-9]{32})$')) { continue }
    $recordId = $Matches[1]
    try {
      $previous = Read-Journal $record.FullName
      if ($previous.phase -ne 'committed' -or $previous.id -ne $recordId) { continue }
    } catch { continue } # Unrecognized records are never used to authorize deletion.
    try {
      if (Test-Path -LiteralPath $previous.backup) { Remove-OwnedDirectory $previous.backup $previous }
      Remove-Item -LiteralPath $record.FullName -Force
    } catch { $ownedBackups += $previous.backup }
  }
  return $ownedBackups
}

function Undo-Install($journal) {
  if ($journal.phase -eq 'committed') { Complete-Commit $journal; return }
  $previousDirectory = $journal.backup
  Assert-PlainPath $previousDirectory
  if (Test-Path -LiteralPath $previousDirectory) {
    if (Test-Path -LiteralPath $target) {
      $marker = Join-Path $target $markerName
      Assert-PlainPath $marker
      $owned = (Test-Path -LiteralPath $marker) -and ((Get-Content -LiteralPath $marker -Encoding UTF8 -Raw) -eq $journal.id)
      if ($owned) { Remove-OwnedDirectory $target $journal }
      elseif (@(Get-ChildItem -LiteralPath $target -Force).Count -eq 0) { Remove-Item -LiteralPath $target }
      else { throw "The old installation is preserved at $previousDirectory. The current directory contains unrecognized files; automatic recovery was stopped." }
    }
    Move-Item -LiteralPath $previousDirectory -Destination $target
  }
  Restore-Registry $journal
  Remove-Item -LiteralPath $journalPath -Force
  Write-Output 'Previous installation restored.'
}

$journal = Read-Journal
switch ($Action) {
  'Prepare' {
    if ($journal) { Undo-Install $journal }
    Assert-CompatibleInstallation
    if (Test-Path -LiteralPath $journalPath) { throw 'Previous installation cleanup is still pending.' }
    $retainedBackups = @(Clear-RetainedBackups)
    $transactionId = [Guid]::NewGuid().ToString('N')
    $transactionBackup = $backup
    if (Test-Path -LiteralPath $backup) {
      if ($backup -notin $retainedBackups) { throw "An unrecognized backup already exists at $backup. Existing files were preserved." }
      $transactionBackup = "$backup.$transactionId"
    }
    Assert-PlainPath $transactionBackup
    if (Test-Path -LiteralPath $transactionBackup) { throw 'The selected backup path is already occupied. Existing files were preserved.' }
    if (-not (Test-Path -LiteralPath (Join-Path $target 'Zen AI.exe') -PathType Leaf)) { return }
    $journal = [pscustomobject]@{
      product = 'Zen AI'; schema = 1; id = $transactionId; phase = 'pending'
      target = $target; backup = $transactionBackup; installKey = $InstallRegistryKey; uninstallKey = $UninstallRegistryKey
      registry = @(Get-RegistrySnapshots)
    }
    Save-Journal $journal
    # A same-volume rename keeps the old version intact and fails safely if a
    # file is still locked. There is deliberately no direct-delete fallback.
    Move-Item -LiteralPath $target -Destination $journal.backup
    New-Item -ItemType Directory -Path $target | Out-Null
    [IO.File]::WriteAllText((Join-Path $target $markerName), $journal.id)
    foreach ($snapshot in $journal.registry) {
      if ($snapshot.path -notin $uninstallKeys -or $snapshot.existed -eq $false) { continue }
      $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$($snapshot.hive), [Microsoft.Win32.RegistryView]::Default)
      try {
        $key = $root.OpenSubKey($snapshot.path, $true)
        try { $key.DeleteValue('UninstallString', $false); $key.DeleteValue('QuietUninstallString', $false) }
        finally { $key.Close() }
      } finally { $root.Close() }
    }
    Write-Output 'Previous installation preserved until the new files are installed.'
  }
  'Commit' {
    if (-not $journal) { return }
    if (-not (Test-Path -LiteralPath (Join-Path $target 'Zen AI.exe') -PathType Leaf)) { throw 'New executable is missing; previous installation retained.' }
    $journal.phase = 'committed'
    Save-Journal $journal
    Remove-Item -LiteralPath (Join-Path $target $markerName) -Force -ErrorAction SilentlyContinue
    Complete-Commit $journal
    Write-Output 'Installation committed.'
  }
  'Rollback' { if ($journal) { Undo-Install $journal } }
}
