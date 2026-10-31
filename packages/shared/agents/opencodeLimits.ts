/** Finite product limits: header wait, whole provider request and idle stream chunk. */
export const OPENCODE_HEADERS_TIMEOUT_MS = 120_000
// Long reasoning/context summaries may stream meaningful work for over three
// minutes. Idle-output guards remain shorter; this is a finite total ceiling.
export const OPENCODE_REQUEST_TIMEOUT_MS = 10 * 60_000
// Native wrapSSE also applies this to its first body read after headers.
export const OPENCODE_STREAM_CHUNK_TIMEOUT_MS = 120_000

// Acceptance probes keep their explicit shorter budget, independently of the
// interactive assistant's ceiling and without extending existing test plans.
export const QUALITY_REQUEST_TIMEOUT_MS = 185_000
