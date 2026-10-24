# Image workbench attribution

The form/preview/history interaction follows dsh-image-gen 0.9.2 by shanliuling.
Source: https://github.com/shanliuling/dsh-image-gen/tree/a961b7f476af651736afa6ab42b795c8e0aa9dc7

The small Blob-to-data-URL helper in src/browserImages.ts is adapted from
src/client/browser-image-utils.ts. Copyright 2026 shanliuling. Apache-2.0;
the full upstream license is included in LICENSE-DSH. No upstream NOTICE was
present at the pinned revision.

The workbench application and styles are rebuilt for Zen-AI's React 19 sandbox,
provider instances, model capabilities and durable task bridge. They do not
import Harness, Cordis, Schemastery, tldraw or the original bundled client.
Generation, history, credentials and recovery use Zen-AI's own task service.
The original multi-request count and HTTP cancellation behavior are not used.
