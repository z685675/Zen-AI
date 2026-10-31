param(
  [Parameter(Mandatory = $true)][string]$InstallDirectory,
  [int]$InstallerPid = 0,
  [ValidateRange(0, 30)][int]$GracePeriodSeconds = 2
)
$ErrorActionPreference = 'Stop'
$roots = @(
  $InstallDirectory,
  [IO.Path]::Combine([Environment]::GetFolderPath('LocalApplicationData'), 'Programs', 'Zen AI'),
  [IO.Path]::Combine([Environment]::GetFolderPath('LocalApplicationData'), 'Programs', 'Cherry Studio')
) | ForEach-Object {
  if (-not [string]::IsNullOrWhiteSpace($_)) {
    $resolved = [IO.Path]::GetFullPath($_)
    if ($resolved -ne [IO.Path]::GetPathRoot($resolved)) { $resolved.TrimEnd('\') + '\' }
  }
} | Select-Object -Unique

function Test-AppProcessPath([string]$Candidate) {
  if ([string]::IsNullOrWhiteSpace($Candidate)) { return $false }
  foreach ($root in $roots) {
    if ($Candidate.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

# Capture the process explicitly: a nested Where-Object changes $_ and used to
# make path matching fail. Restrict both graceful close and force close to roots.
$targets = @(Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne $PID -and $_.ProcessId -ne $InstallerPid -and (Test-AppProcessPath $_.ExecutablePath)
})
if ($targets.Count -eq 0) { Write-Output 'No application processes remain.'; exit 0 }
foreach ($target in $targets) {
  try { $process = Get-Process -Id $target.ProcessId -ErrorAction Stop; [void]$process.CloseMainWindow() } catch {}
}
$deadline = [DateTime]::UtcNow.AddSeconds($GracePeriodSeconds)
foreach ($target in $targets) {
  try {
    $process = Get-Process -Id $target.ProcessId -ErrorAction Stop
    $remaining = [Math]::Max(0, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)
    if ($remaining -gt 0 -and $process.WaitForExit($remaining)) { continue }
    # Recheck the executable before terminating, including possible PID reuse.
    if ($process.Path -eq $target.ExecutablePath -and (Test-AppProcessPath $process.Path)) {
      Stop-Process -Id $process.Id -Force -ErrorAction Stop
      [void]$process.WaitForExit(1000)
    }
  } catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
    # A process that already exited needs no action.
  }
}
$remainingTargets = @(Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne $PID -and $_.ProcessId -ne $InstallerPid -and (Test-AppProcessPath $_.ExecutablePath)
})
if ($remainingTargets.Count -gt 0) { throw 'Application processes are still running; existing files must not be replaced.' }
Write-Output ('Checked {0} remaining application processes.' -f $targets.Count)
