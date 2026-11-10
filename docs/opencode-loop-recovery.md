# Skipping repeated operations

OpenCode v1.19.5 asks for `doom_loop` approval after repeated identical tool input. Rejecting it terminates its current processor, unlike an ordinary recoverable tool failure. Zen treats an explicit user rejection of this guard as **skip the repetition and continue the task**. The task's Stop button retains its original cancellation behavior.

The adapter replies `reject`; it never silently approves the repetition. It cancels sibling approval dialogs because native rejection clears every pending permission in the same native session. Noninteractive rejection, missing windows, user Stop and unrelated model/network failures do not trigger continuation.

Exception for provably invalid read-only arguments: repeated `mcp__assistant__web_search`
without a nonempty query, or `mcp__browser__open` / native `webfetch` without a nonempty
URL, is rejected before displaying an approval. This is not permission to execute a
malformed operation. The same native idle/abort barrier then submits one bounded
parameter-correction message. A second invalid loop switches to tool-free finalization
using existing evidence, with missing requirements disclosed. This budget is shared
with the existing three-recovery ceiling. Valid repetitions, unknown tools, empty
inputs to no-argument tools, writes and ordinary authorization are unaffected.
The continuation accurately describes the runtime rejection, not a user decision.

After native idle, the adapter awaits the native abort endpoint as a cleanup barrier. Native emits an early idle before releasing its runner; submitting immediately can otherwise join that dying run. This barrier settles the abandoned generation and its parallel/background work.

Continuation uses one new synthetic message in the same native session, with the same model, workspace instructions and permission mode. It does not replay the original task or attachments, delete history, or retry ambiguous submissions. Successfully completed tool output from the failed generation is included as bounded source excerpts because native model replay skips assistant messages carrying errors. Earlier successful generations remain in native history. Existing user guidance and its delivery receipts remain associated with this run.

Two attempts to change approach are allowed after explicit user skips. On a third skip, a hidden primary agent with all tools denied must finish using existing evidence and explain missing requirements. This agent changes no persistent session permissions; subsequent normal turns still use Build/Plan as selected. This cannot guarantee completion when required evidence or external services are unavailable, and must never claim nonexistent files or results.

Diagnostics record `doom-loop-continued` with attempt, native message ID, finalization flag and excerpt size. Terminal permission rejections are classified as local authorization interruptions, separately from upstream stream/network errors.

Automatic invalid-read rejection also records `invalid-tool-loop-skipped`; continuation
records include `reason: invalid-arguments` versus `user-skipped`. These events do not
record raw query/URL values. They do not prove the model/provider bug was repaired.

Validation:

- `pnpm test` covers same-session continuation, successful evidence, stale idle, no-window rejection, unrelated errors, explicit Stop, sibling dialogs, user guidance receipts and ambiguous admission.
- `pnpm smoke:opencode --loop-recovery` uses the actual bundled native binary and a local fake model. It exercises three real rejections, preserved evidence, tool-free finalization and the following Build turn, with zero paid requests.
- `pnpm smoke:opencode --invalid-loop-recovery` returns actual empty-argument MCP search calls from a local fake model, validates native permission metadata, performs one automatic repair then tool-free finalization, and checks preserved evidence and the following Build turn. It makes three local model requests and zero paid requests.

Native implementation reference: [OpenCode v1.19.5](https://github.com/anomalyco/opencode/tree/v1.19.5), `session/processor.ts`, `session/run-state.ts`, `effect/runner.ts`, `session/message-v2.ts`, and `permission/index.ts`.
