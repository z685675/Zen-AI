# Zen AI Release Template

Use this template when publishing a new source release on GitHub.

## Title

`Zen AI vX.Y.Z`

## Summary

Zen AI `vX.Y.Z` is now available.

- Source tag: `vX.Y.Z`
- Source repository: <https://github.com/z685675/Zen-AI>
- Installers: distributed separately through your chosen cloud drive
- Update mode: full-package install only, no in-app auto-update

## What Changed

- Added:
- Changed:
- Fixed:
- Removed:

## Packages

Windows

- `Zen-AI-X.Y.Z-x64-setup.exe`
- `Zen-AI-X.Y.Z-x64-portable.exe` (optional)

macOS

- `Zen-AI-X.Y.Z-arm64.dmg` or `.zip`
- `Zen-AI-X.Y.Z-x64.dmg` or `.zip`

## Checksums

Fill in the SHA256 values for every published installer.

```text
Zen-AI-X.Y.Z-x64-setup.exe:
Zen-AI-X.Y.Z-x64-portable.exe:
Zen-AI-X.Y.Z-arm64.dmg:
Zen-AI-X.Y.Z-x64.dmg:
```

## Upgrade Notes

- Close Zen AI before replacing or reinstalling the package.
- This project does not provide in-app update checks.
- Existing users should download the latest full installer package manually.

## Compatibility Notes

- Zen AI is an independent branded build based on Cherry Studio.
- Zen AI is designed to coexist with the original Cherry Studio.
- Zen AI does not automatically migrate Cherry Studio user data.

## Rollback

- Keep the previous installer package available for rollback.
- Make sure the rollback package matches a public Git tag and source snapshot.

