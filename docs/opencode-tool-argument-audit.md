# Tool argument boundary audit

This is diagnostic observation, not a replacement tool execution loop. The
gateway still forwards request and response bytes unchanged. No extra model
request, tool retry or generation is introduced by the audit.

## Boundaries

- Outbound JSON request: inspect the tool schema actually sent by the native SDK.
  Keep a keyed schema fingerprint and required field names in memory only.
- Provider HTTP response: assemble each call's argument deltas independently by
  choice/tool index, Responses item/call ID, or Anthropic content-block index.
  Also observe non-streaming responses and final snapshots. A conflicting final
  snapshot is reported separately, without rewriting either representation.
- Native decoded tool call: observe the input in the original native session
  event before adapting it for the renderer. Native call IDs match HTTP call IDs.
- Product/browser MCP request: observe arguments received at the local MCP
  boundary before tool validation. JSON-RPC IDs are not native call IDs. Correlate
  by tool name and input fingerprint only when both are unique in the turn.
- Zen API: optional server evidence includes `upstream-raw` and `client-forward`
  per-attempt records. Compare same-call fingerprints within the API attempt.
  Server keys differ from client keys; never compare their fingerprints directly.
  These records require deploying the accompanying API changes.

The archive contains `tool-arguments.json` and `工具参数对账.txt`, including in
metadata-only exports. `transport-config` records `toolArgumentAuditVersion: 1`
and `loopRecoveryVersion: 1`. Missing markers mean unknown/older collection,
not proof that a renderer refresh loaded the current main-process code.

## Privacy and bounds

No prompts, parameter values or tool outputs are recorded by this feature.
Canonical argument JSON is fingerprinted with a random HMAC key for each client
turn / API attempt. Keys are never exported. JSON whitespace and object property
order do not create mismatches; fingerprints from different scopes cannot be
compared. Tool names, call/request IDs, sizes, states and field counts remain.

Client request inspection is limited to 2 MiB, each argument to 256 KiB / 10,000
nodes / depth 64, response assembly to 128 calls and 2 MiB of fragments/snapshots.
SSE and JSON parsing retain the usage observer's existing frame/body bounds.
The API limits each boundary to 64 calls, 512 KiB per argument/body/frame, and
2 MiB of inspected response bytes. Completed server records discard raw buffers.
Capacity limits, invalid/unfinished frames and dropped timeline events remain
explicit. They must never be interpreted as empty arguments.

Request boundaries, runtime capability markers and tool-argument audit events
have a separate per-operation ledger (1,024 events / 1 MiB of serialized
characters). Ordinary progress, including transport progress, retains its own
160-event budget and cannot evict the ledger. Exports merge both lanes in their
original order, persist both on completion, and report general and protected
drops separately. The audit collector's own per-turn cap remains explicit too.
Only diagnostic timeline/performance/audit JSON exports use larger, bounded
array limits; other content exports retain their existing limits. The audit text
is redacted per line so a long report no longer silently loses its middle.

An empty object is valid for a zero-argument tool. Only the actual observed schema
can establish missing required fields. The audit reports top-level required
fields, not full JSON Schema validation or whether the model understood the task.

## Verification and use

1. Completely restart the development client (including its main process).
2. Deploy the API change if comparing the two API boundaries is needed. Client
   diagnostics still work against an older server; server evidence is unavailable.
3. Continue the saved task. Choose “跳过重复并继续” to skip a repeated operation;
   the Stop control still cancels the whole task. Preserve the workspace/history.
4. Export a new diagnostic package from that turn. Read runtime capability
   markers first, then compare call IDs and boundaries. Do not reuse an older
   package to infer data the earlier version did not collect.

Regression coverage includes interleaved calls, split UTF-8 Chinese arguments,
final-only and conflicting snapshots, all three supported wire protocols,
zero-argument tools, missing required fields, truncated/invalid/oversized streams,
MCP identity ambiguity, private exports and byte-transparent forwarding. The
cost-free native `pnpm smoke:opencode --loop-recovery` separately verifies
permission recovery and bounded tool-free finalization.
