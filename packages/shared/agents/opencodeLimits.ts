/** Finite product limits: header wait, whole provider request and idle stream chunk. */
export const OPENCODE_HEADERS_TIMEOUT_MS = 120_000
export const OPENCODE_REQUEST_TIMEOUT_MS = 180_000
// Native wrapSSE also applies this to its first body read after headers.
export const OPENCODE_STREAM_CHUNK_TIMEOUT_MS = 120_000

// Let the native request limit report first; explicit shorter acceptance budgets still win.
export const QUALITY_REQUEST_TIMEOUT_MS = OPENCODE_REQUEST_TIMEOUT_MS + 5_000
