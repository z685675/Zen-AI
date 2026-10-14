# Zen AI Agent Entry

This file is the quick entry point for AI assistants working directly inside the `zen AI` repository.

## Read This First

- This repository is the primary active project inside the parent workspace.
- It is a customized fork/product derived from Cherry Studio.
- Unless the user explicitly asks otherwise, all implementation work should happen here.

## Repository Role In The Parent Workspace

- `../zen AI/`: main development target
- `../cherry-studio-upstream/`: upstream reference, usually read-only
- `../cherry-studio-1.9.4/`: local version snapshot, usually read-only

If the user mentions "compare with upstream" or "check old 1.9.4 behavior", inspect those sibling directories for reference, but keep edits here by default.

## Assistant Product Boundary (2026-10-12)

- Future assistant development and feature extensions target the OpenCode-based new assistant only.
- The legacy/deprecated assistant is no longer maintained and is view-only. Preserve history, exports, file access and continuation into the new assistant; forbid sending, retrying or executing tasks in the old assistant, including in developer mode.
- Legacy WeChat and other external channels, scheduled tasks and heartbeats are shut down, including existing enabled connections/runs. Keep configuration, credentials and history; do not delete them or auto-resume them after restart.
- Developer mode does not bypass this shutdown. New integrations require a separate implementation and user authorization before reopening.
- Do not transplant legacy execution loops, retries, compression or large prompts into OpenCode; preserve its native stability.

## Code Layout

- `src/main/`: Electron main process
- `src/preload/`: preload bridge
- `src/renderer/src/`: React renderer application
- `packages/`: workspace packages
- `tests/`: automated tests
- `scripts/`: repo scripts

## Instruction Source

- Detailed repository conventions live in `CLAUDE.md`.
- Treat `CLAUDE.md` as the extended engineering guide for this repository.
