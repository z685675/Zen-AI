# Native database connection lifecycle

The pinned `libsql@0.4.7` patch includes a native-connection lifetime guard. Keep
the Windows ARM loader change in the same patch when updating it.

## Reason

Four development main-process dumps on November 3–4, 2026 contained Windows
`0xC0000005` at `@libsql/win32-x64-msvc/index.node+0x4ec114`. The native stack
contains two calls to the SQLite close function from the same connection drop
path. In the pinned Rust dependency, both `LibsqlConnection::drop` and
`Connection::drop` call `disconnect()`, which tests whether the connection is the
last owner without marking that it has already disconnected. A second call can
therefore read an already freed SQLite handle. It occurs during native GC and
bypasses JavaScript exception handlers.

Relevant upstream source:

- [Pinned libsql-js dependency revision](https://github.com/tursodatabase/libsql-js/blob/v0.4.7/Cargo.toml)
- [LibsqlConnection drop](https://github.com/tursodatabase/libsql/blob/20147731c4a9d6e942b159f183215e9399fda2c3/libsql/src/local/impls.rs#L84)
- [Connection drop and disconnect](https://github.com/tursodatabase/libsql/blob/20147731c4a9d6e942b159f183215e9399fda2c3/libsql/src/local/connection.rs#L28)

## Guard

Each JavaScript database keeps one unexecuted `SELECT 1` prepared statement in a
module-private lifetime record. Its independent native connection owner remains
alive while the outer connection is explicitly released. When the guard itself
is collected, its connection owner closes the SQLite handle once. The statement
is never executed and creates no cursor, transaction, or persistent schema.

The record contains native handles, **not the JavaScript database wrapper**.
`FinalizationRegistry` releases abandoned transaction connections through the
same guarded path as explicit `close()`. Successful close unregisters the record;
repeated close is harmless. Failed close keeps the record and guard alive, and
explicit callers still receive the error. One process exit hook releases any
remaining records before native teardown. This applies to every consumer of the
patched driver, including agent history, memory and knowledge databases.

No schema, file format, database path or application data changes are needed.
This is a targeted workaround for the pinned native dependency, not isolation
from every possible future native crash.

## Verification and removal

Run `node scripts/libsql-lifecycle-smoke.js` after installing dependencies. It
uses separate real Electron main processes and newly generated databases under
`local/`; it never opens application data or sends model requests. By default it
runs three rounds of 10,000 Drizzle transactions with forced GC, plus explicit
close/reopen and live-connection shutdown tests. It checks commit/rollback,
Unicode and binary parameters, vector functions, persistence, database integrity
and release of Windows file handles. CI runs the same check before packaging.

The unpatched driver reproduced exit code `3221225477` within this workload.
Remove the guard only after an upstream native lifetime fix is verified against
the same workload without the patch, including actual process teardown and file
release. A version bump or passing JavaScript mocks alone is insufficient.
