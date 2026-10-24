# infinite-canvas in Zen-AI

Source: https://github.com/basketikun/infinite-canvas

Pinned release: v0.20.0, commit `3a6b64b602ad062b29fac66902ed18a7ef5fd9dc`.
Copyright (c) basketikun. MIT license retained in LICENSE and the bundled UI.

This directory contains a modified copy of the upstream web application. Zen-AI
supplies a restricted local entry point, provider catalog, image request bridge,
task recovery and local persistence. Remote plugins, model scripts, analytics,
Agent connections, external prompt sources and independent credential configuration
are disabled in this build. Only local canvas routes are mounted.

Run `pnpm --filter @zen-ai/image-canvas typecheck` and `build`. The desktop build
also builds this package into resources/image-canvas and includes its MIT license.
Upstream formatting is preserved; this directory has an independent typecheck.
