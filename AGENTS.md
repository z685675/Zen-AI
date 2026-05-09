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
