# Client update flow (2026-10-31)

Automatic checks download in the background and show a prompt only after the
installer is ready. Manual checks offer Download first; that same dialog shows
live progress and becomes Install when the download finishes. Reopening an
ongoing download shows its progress without starting another request. Long
release notes scroll independently of the fixed action buttons. Errors and
cancelled task-exit confirmations leave the prompt retryable.

A persisted pending version is initially `checking`, not proof of a ready
installer. Startup restores and verifies the updater cache before announcing
`downloaded`, moving preparation out of the usual Install click path. Windows
retains the pending record until a newer application starts: quit notifications
do not prove successful installation. Install preparation and launch are single
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

Validation must include the update service, dialog/stream races, exit guard,
scoped Windows cleanup, native NSIS compilation and a parent-wait probe. Exercise
the actual AntD dialog with long notes in small windows. Before public release,
use a complete packaged upgrade from the previously shipped version to verify
Windows installer/UAC/tray behavior and data retention; Windows checks do not
substitute for macOS device acceptance. Do not publish merely because an
installer process was invoked.
