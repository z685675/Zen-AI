# Client update flow (2026-11-01)

Automatic checks download in the background and show a prompt only after the
installer is ready. Manual checks offer Download first; that same dialog shows
live progress and becomes Install when the download finishes. Reopening an
ongoing download shows its progress without starting another request. Long
release notes scroll independently of the fixed action buttons. Errors and
cancelled task-exit confirmations leave the prompt retryable.

A persisted pending version is initially `checking`, not proof of a ready
installer. Startup restores and verifies the updater cache before announcing
`downloaded`, moving preparation out of the usual Install click path. Both Windows
and macOS retain the pending record until that version or a newer application
starts: quit notifications and opening a DMG do not prove successful installation.
Metadata checks, downloads and cache restoration coordinate their in-flight
promises. A manual request waits for cache restoration; downloads wait for the
current metadata check, and installation waits for the active download. Newer
metadata clears older persisted pending records even when startup has not yet
verified them. Concurrent preparation of the same Mac version shares one file
verification/download. After transient SDK metadata events, a verified cached
package is announced again as downloaded to reconcile live renderer state.
Restarting the old Mac app verifies the cached DMG again and restores the waiting
update without another download when it is valid. Install preparation and launch are single
flight. Unrelated `before-quit` events cannot confirm update installation; launch
errors remove listeners and permit retry. Numeric install-stage durations are
logged for requested, exit-confirmed, preparing-package, package-ready,
launching-installer and quit-for-update.

The Windows installer waits for the inherited parent PID before checking running
processes. For older clients without the marker, `--updated` gives scoped process
cleanup a 30-second grace window, covering the application's bounded 20-second
shutdown. Other installs use a two-second grace period. Neither path adds a
fixed delay when no processes remain. Process cleanup matches exact install-root
boundaries, excludes the installer, and rechecks executable identity before
force-close; it does not use broad process-name kills. macOS retains local DMG
installation with Finder fallback; stalled downloads and redirects are bounded.
Windows cleanup and old-file replacement run only after confirmation of the
installation target and prerequisite checks. Failure to close remaining processes
offers Retry/Cancel before old files are removed; opening/cancelling Setup alone
does not remove the existing installation.

Windows installer launch now awaits the operating system's `spawn` result. When
elevation is needed, it awaits the helper's exit status after the UAC decision
(without the helper's wait-for-installer option). A launch error or declined UAC
does not quit Electron and resets the SDK's install guard for the first retry.
The launch-notification watchdog starts after this decision, so it cannot time
out a still-pending UAC prompt. The parent PID environment is captured before
asynchronous elevation fallback. These changes are maintained in
`patches/electron-updater@6.7.0.patch`, including the existing cache-query fix.

Before overwrite, `build/install-transaction.ps1` renames the previous install to
the sibling `.zen-ai-previous` directory and records owned registry values in a
durable `.zen-ai-update.json` journal. The old uninstaller is bypassed only after
the backup exists. No recursive-delete fallback is used when rename fails. The
backup is removed only after payload installation succeeds. NSIS failure/exit
callbacks restore files and registry values; after a hard interruption, the next
installer recovers the pending transaction first. Unknown backup directories,
unrecognized partial files and directory junctions stop destructive cleanup.
Recovery journals are explicitly read and written as UTF-8, including older
records without a BOM, so Chinese paths and registry values survive recovery
under Windows PowerShell 5.1.

If a successful installation leaves locked files or junctions in its old backup,
its committed journal becomes `.zen-ai-update.json.retained.<transaction-id>`.
Later installers retry this owned cleanup and can use a unique sibling backup
for their own transaction while the old backup remains. A failed new installation
restores its own previous version, never the obsolete retained version. A missing
or invalid ownership record still prevents use or deletion of an occupied backup;
pending failed-install journals are recovered rather than deferred. Retained
files can remain on disk while cleanup is obstructed, without blocking upgrades.
The `app-builder-lib@26.8.1` patch inserts the preparation hook after directory
selection in both ordinary and elevated installations. Preserve this hook when
upgrading the builder dependency.

Upgrades must keep the original install directory and user/all-user scope.
Before changing files or disabling the old uninstaller, preparation checks the
registered installation and both current and legacy uninstall keys. An unsafe
directory/scope change is stopped with a localized explanation. Relocation
requires explicitly uninstalling the old version while retaining personal data,
then installing at the new location. Recovery includes removing product registry
keys that did not exist before the failed upgrade. It never removes another
installation's keys as part of an ordinary current-user upgrade.

macOS readiness requires the DMG's published SHA512, size (when provided), and
UDIF trailer, for both cached and newly downloaded files. ZIP checksums and files
for the other architecture are excluded. Old pending records without checksum
metadata refresh that metadata for the same version with automatic ZIP download
disabled. If that version's metadata is no longer available, the user must check
for updates again. Verification failures never open the file or quit the app.
Redirected downloads use a single completed temporary payload before rename.
Downloads have a 45-second response-header deadline and 30-second socket
inactivity timeout. Failure destroys the request/response and closes and removes
the partial payload before a retry. Dialog snapshots reconcile missed failure
events and offer retry instead of leaving a disabled Download button. A late
snapshot cannot overwrite newer live progress, completion or install actions.

Focused regression checks:

```sh
pnpm exec vitest run scripts/__tests__/updater-launch.test.ts scripts/__tests__/installer-transaction.test.ts scripts/__tests__/installer-bitness.test.ts src/main/services/__tests__/installer-process.test.ts src/main/services/__tests__/AppUpdateService.test.ts src/main/services/__tests__/MacInstallerValidation.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism
```

The SDK tests replace process creation only; they exercise the shipped SDK's
launch handling. Recovery tests use actual Windows files and unique test registry
keys, plus a compiled NSIS failure fixture when the compiler cache is available.
They do not run the real application installer or alter a user's installation.

Validation must include the update service, dialog/stream races, exit guard,
scoped Windows cleanup, native NSIS compilation and a parent-wait probe. Exercise
the actual AntD dialog with long notes in small windows. Before public release,
use a complete packaged upgrade from the previously shipped version to verify
Windows installer/UAC/tray behavior and data retention; Windows checks do not
substitute for macOS device acceptance. Do not publish merely because an
installer process was invoked.
