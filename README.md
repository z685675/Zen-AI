# Zen AI

Zen AI is an independent desktop AI workspace built from the Cherry Studio open-source codebase and released under AGPL-3.0.

## Project Status

- Current public baseline: `v1.0.0`
- Platforms: Windows and macOS only
- macOS packages: `x64` for Intel Macs and `arm64` for Apple Silicon Macs
- Update strategy: no in-app auto-update or manual update check
- Distribution: GitHub source releases plus full installer packages distributed separately

## Download And Upgrade

- Download source releases: <https://github.com/z685675/Zen-AI/releases>
- Installers are distributed as full packages. Close the app before replacing or reinstalling.
- Every published installer must map to a matching GitHub tag and source snapshot.

## Branding And Compatibility

- Zen AI uses its own app identifier, protocol scheme, and local data directory.
- It is designed to coexist with the original Cherry Studio on the same machine.
- It does not migrate or reuse Cherry Studio user data automatically.

## Open Source Notice

- This project is based on Cherry Studio and keeps the required open-source obligations for redistributed builds.
- Zen AI is released under AGPL-3.0.
- If you distribute modified binaries, you must also provide the corresponding source code.

## Development

```bash
pnpm install
pnpm dev
```

Build commands:

- Windows: `pnpm build:win`, `pnpm build:win:x64`, `pnpm build:win:arm64`
- macOS: `pnpm build:mac`, `pnpm build:mac:x64`, `pnpm build:mac:arm64`

## Links

- Repository: <https://github.com/z685675/Zen-AI>
- Documentation: <https://github.com/z685675/Zen-AI#readme>
- Feedback: <https://github.com/z685675/Zen-AI/issues/new/choose>
- Support: <mailto:yewanzz@qq.com>
