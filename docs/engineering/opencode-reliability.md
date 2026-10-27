# New assistant: confirmations and avoidable latency

The October 26, 2026 diagnostic review found a task that waited 30 minutes on native `doom_loop` approval, and three successful tasks with 22–25 model requests. File-tool execution was short; unnecessary model round trips, parameter corrections and browser trial-and-error dominated avoidable latency. Request duration includes the provider/channel/network path and does not measure model computation alone.

## Confirmations without a tool call

Native permission events do not always contain `tool.callID`. Such requests now use the reserved ID `${sessionId}:permission:${permissionId}`. `AgentSessionPermissions` reads the existing permission store and shows confirmations outside the message scroll, scoped to the active new-assistant session. It does not require a matching tool block or create a new state slice.

Both native metadata and patterns reach the user. Repeated-operation protection receives a clear explanation. Resolved session-level confirmations are removed immediately because no tool result will arrive to clear them. Tool-linked approvals retain the existing lifecycle. Only the native one-time reply is sent; this change does not grant persistent approval, disable loop protection or change task deadlines.

Each session-level card addresses its exact permission request ID. Multiple requests for one tool cannot approve one another accidentally. Pending requests take precedence over earlier approved requests, and a finished tool clears all of its permission entries.

Local deadline errors take precedence over a later SDK wrapper when attributing the terminal failure. When live events expire, a saved error code can still establish a local deadline. This locates the timeout; it does not prove why the earlier task stopped making progress.

## Fewer corrective round trips

- `present_files` keeps `file_paths` as the canonical contract and accepts the observed `paths` alias at the same non-mutating boundary. Conflicting lists fail. Authorization, existence and content validation still run for every file.
- XLSX tool guidance and row-validation errors show a two-dimensional example, including the header. The tool does not guess how to repair a flat array or invent formula results.
- Invalid MCP parameters are classified as `invalid_input`, with automatic retry disabled.
- The bounded OpenCode contract encourages independent skill reads/file work in batches, reuse of loaded guidance, phase-level todo updates, and correction of all required fields before retry. OpenCode still owns its loop, retry and compaction behavior.

## Browser click and verification

`snapshot` returns an opaque snapshot ID and numbered element refs. `click` consumes those refs, validates that the target is current, visible, enabled and unobstructed, and sends one native CDP mouse click. Optional `expectedText` observes that same element for a bounded period. If the expected state is already present, no click is sent.

Snapshots expire on navigation or a new snapshot. Missing confirmation of the result is not success and never triggers a second click automatically. Interrupted dispatch/verification is explicitly uncertain; inspect the current page before another action. Browser operations within a tab should be sequential. Public-page research, login/CAPTCHA handoff, and existing confirmation rules for sensitive actions still apply.

The controller reserves snapshot/ref pairs before input and retains the latest 512 reservations to block concurrent and recent duplicate calls. Already-satisfied state checks remain read-only. A new intended action needs a fresh observation, rather than replaying a target whose previous effect is uncertain.

This replaces repeated arbitrary selector guesses for ordinary visible controls. It is not a universal site-specific automation adapter, and it cannot guarantee completion time or successful interaction on every website.

## Historical diagnostic exports

`buildTurnPerformance` reads validated, content-free `opencodeDiagnostics` already saved on the message. Exports retain cumulative request/tool/retry counts and durations when ephemeral event buffers have expired. Missing counts are null, not invented zeroes. Aggregate fallback is labeled; missing request/tool intervals are not reconstructed. Metadata-only exports allow-list both statistics and nested error codes and omit prompts, arguments, results and error text.

Cumulative request/tool times may overlap and must not be added as a wall-clock partition. Response-header wait is not first-token time. Persisted runtime totals exclude preparation that happened before the OpenCode adapter.

## Exact PDF pagination and portable CJK output

The 18:19 diagnostic export completed in 167.994 seconds with 15 model requests, 20 tool calls, no retries and no user-wait intervals. It still missed the requested two-page PDF: the model wrote eight one-page PDFs while trying headings, HTML page breaks and added text. The exporter/runtime completion status did not establish that the page requirement had been met.

`create_file` now accepts `pdf_pages`, an array of nonempty Markdown strings, and `expected_pages`. The array establishes explicit page boundaries and defaults the expected count to its length. Standalone `<!-- pagebreak -->` lines and the observed empty HTML page-break divs also work in `content`. Leading, trailing and duplicate breaks do not create blank pages; fenced-code examples stay literal. Ordinary headings and horizontal rules keep their existing behavior.

The generated buffer's actual page count must match the declared count before any output is written, a numbered alternative is created, or overwrite approval is requested. Overflow produces a validation error with expected/actual counts and corrective guidance. The tool does not clip content, invent padding, delete earlier files, or infer a requested count from unrestricted prose. The tool contract and bundled PDF Skill tell the model to declare exact counts and avoid repeated guesses.

Independent Poppler rendering also exposed two `@pdf-lib/fontkit@1.1.1` CFF subset defects: the header used the font dictionary count as `offSize`, and returning to a previously seen font dictionary assigned glyphs/local subroutines to the last dictionary. A pinned pnpm patch fixes the CommonJS and ESM entry points. Chinese glyphs remain embedded as a compact subset; full-font embedding and OS-specific fonts are unnecessary. Regression coverage checks the embedded CFF header and alternating CJK/Latin dictionary mapping. Both pages of the ZX7319 fixture were rendered and visually checked with Poppler, including the final 700-yuan budget on page two.

Installing the patch exposed an existing workspace lockfile mismatch: image-workbench resolved React/React DOM 19.2.5 while the host resolved 19.2.3. Its compatible existing ranges now resolve to the host versions in the lockfile, including the react-i18next peer snapshot. A frozen offline install confirmed that the host and workbench resolve the same React module; all 17 workbench tests passed. No dependency ranges or React APIs were changed.

## Verification

- Regression tests cover unlinked confirmation approval/denial and navigation, one-time native permission replies, the delivery alias with invalid/conflicting/out-of-scope files, local deadline attribution, metadata privacy, and historical aggregate fallback.
- `pnpm exec tsx scripts/assistant-browser-click-smoke.ts` runs real Electron/CDP against an isolated local page. It verifies trusted input, state observation, already-satisfied state, no blind retry, hidden/disabled targets and stale refs. It uses a temporary browser profile and no external website or paid model.
- `pnpm exec tsx --tsconfig tsconfig.node.json scripts/opencode-runtime-smoke.ts --permissions` checks native automatic file output and guarded sensitive reads/deletion with explicit one-time approval, using a local model fixture.
- The four supplied diagnostic packages were replayed through the new pure report/attribution functions: the failed task was classified as a local deadline, and the successful tasks retained 22/24/25 requests and 21/22/23 tools.
- Before the PDF follow-up, full regression passed 539 test files and 6,332 tests, with 9 skipped. The later permission-isolation and diagnostic edge-case regression passed all 71 tests across six files. Lint, all configured type checks, i18n checks and the production build passed. Browser smoke includes concurrent duplicate clicks.
- PDF follow-up: `pnpm test` with the output-generator, runtime-tool and workbench files passed all 88 tests. The broader four-worker run passed 538 files / 6,343 tests, skipped 9, and found one premature workbench UI assertion. That assertion now awaits the asynchronously loaded size control; the 88-test run after this correction passed. The entire broad suite was not repeated after this test-only correction. Format, lint, configured type checks, i18n checks and the production build passed with the final dependency lockfile.

Real end-to-end latency must be compared with the same task, model, provider/channel and login state. The local click smoke duration is not a prediction for the original B站 task or document-generation tasks.
