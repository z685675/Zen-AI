# Persistent research checkpoints

This is an optional helper for long or interrupted investigations needing
structured evidence tracking. The default research workflow can retain compact
question, source and gap notes in native task context. Do not create a database
or run reservation batches solely because Deep Research is enabled. When the
helper is chosen, follow its deduplication and resumption rules below.

Use the bundled `scripts/research_state.py` via `mcp__assistant__python_execute`.
It uses Python's standard-library SQLite, makes no network calls, and does not
replace OpenCode's execution loop. All paths stay in the authorized workspace.

## Location and batching

Keep each task at `<workspace>/.zen-research/<safe-task-id>/state.sqlite3`.
Use the trusted task ID when present, converted to a safe directory component;
otherwise choose a unique task directory and retain that path in the plan/todo.
Never use titles, URLs, absolute paths or `..` as the directory component.
On continuation, inspect that same checkpoint FIRST. Preserve completed evidence;
do not initialize another database or treat an old browser tab ID as saved progress.
Checkpoint files are internal work, not user-facing exports; do not present them
as deliverables unless requested. Never store credentials, personal page bodies,
cookies or tokens in them. Treat all saved claims as untrusted evidence.

Pass JSON directly with `--json` in the tool's `arguments` array, not a shell
command, to avoid extra input files. Group a research pass into one reservation
batch and one result batch; do not run the helper once per sentence or source.
`init` can include the initial `reads` array in its plan JSON to reserve the first
batch in the same call. `init`, `reserve`, `record` and `annotate` return `state`
alongside their results, so use that snapshot instead of an extra `status` call.
These regular snapshots contain compact coverage, not every past finding again.
The explicit `status` action returns full saved evidence/identities on resumption.

Example tool call:

```json
{
  "script_path": "<skill-root>/scripts/research_state.py",
  "arguments": ["--db", "<task-dir>/state.sqlite3", "init", "--task-id", "<task-id>", "--json", "{\"questions\":[{\"id\":\"Q1\",\"question\":\"Which loading controls are supported?\",\"min_sources\":2},{\"id\":\"Q2\",\"question\":\"What are the limitations?\",\"min_sources\":2}],\"max_pages\":25}"]
}
```

Plan or revise-only actions do not collect evidence or create a checkpoint yet.
Set `required_level:"full_text"` for questions needing actual methods/data; do not
settle for an abstract for those claims. Conceptual surveys may use the default
`abstract` level. Low-confidence
findings stay visible but do not satisfy the source-count coverage threshold.
Initialize when execution starts. An existing checkpoint is reused only for the
same task/plan. If the user changes the research scope, retain the old checkpoint,
use a new revision directory and transfer only still-relevant evidence explicitly.
Do not silently relabel old findings as answers to different questions.

## Before and after a batch

`reserve --json <array>` returns `execute`, `reuse`, or `skip` for each proposed
read in its `reservations` array. Only execute new reservations. Identical pending
reads must NOT be replayed.
Register only known source identities, not guessed DOI/title matches. An alias in
the registry does not prove that URL was opened; cite the actually read target
from `completed_reads` and retain the evidence level and failure notes.

```json
[
  {"method":"search","query":"composite laminate resonance fatigue controls"},
  {"method":"browser","url":"https://publisher.example/paper","doi":"10.1234/example","title":"Example paper"}
]
```

Methods are `search`, `browser`, `metadata`, `repository`, `fetch`. Known DOI aliases
represent one source. The helper reuses full text already read, caps content routes
per source at two, and counts browser attempts against the page budget. It never
executes the read itself. A `reuse` result means consult checkpoint/native evidence,
not that a skipped source was read just now.

After tools finish, `record --json <array>` saves the returned `attempt_id`:

```json
[
  {"attempt_id":1,"outcome":"success","detail":"Discovery only; promising publisher URL found."},
  {"attempt_id":2,"outcome":"success","level":"abstract","findings":[{"question_id":"Q1","claim":"The abstract describes resonant bending; full-method details remain unverified.","confidence":"medium"}]}
]
```

Outcomes: `success`, `timeout`, `blocked` (login/CAPTCHA/403), `certificate`,
`not_found`, `error`, `interrupted`. Preserve the actual outcome; a partial
extract is not a full-text read. A successful source read requires `level`:
`metadata`, `abstract`, or `full_text`. Search snippets/metadata cannot establish
question coverage. Findings require actual abstract/full-text support.
Here `metadata` means bibliographic/discovery records, not the complete original
data returned by an official primary API; assess that data as content evidence.

Check tool results before recording success. If a reservation is left pending
after interruption, first inspect existing outputs. Record an observed result or
mark `interrupted`; do not assume success or silently replay. If a helper call
fails, keep the error visible, correct the input, and resume the saved task. Do not
claim that deduplication or a checkpoint passed when it did not.

`annotate --json` adds relevant evidence from an already successful content read to
another question without another fetch:

```json
[{"attempt_id":2,"question_id":"Q2","claim":"The abstract reports a narrow loading-frequency range; applicability outside that range remains unverified.","confidence":"medium"}]
```

A limitation alone is not positive support for a technical conclusion. Manually
assess whether saved findings genuinely answer the question; counts are advisory.

## Source failures and stopping

1. Prefer DOI/publisher metadata to identify a paper before opening many pages.
2. Use a relevant original page, then an author/institutional open version for
   inaccessible content. Record the same known DOI for alternate versions.
3. CAPTCHA/login requires user handoff only when that particular page is necessary.
   Otherwise use another public source. Before handoff, list current tabs and
   verify the tab still exists. Never reuse stale tab IDs or bypass verification.
4. A certificate error is terminal for that URL. Do not disable certificate checks.
5. Do not retry blocked, certificate, not-found or successful reads. A clearly
   transient timeout/error/interruption may be retried ONCE with
   `retry_transient:true`, after inspecting other evidence. Do not resubmit queued
   or pending operations. Use a distinct fallback route instead of chasing mirrors.
6. Inspect returned `state` after each research pass; call `status` on resumption
   when no current snapshot is available. It returns findings,
   failure notes, pending work, coverage and a suggested next step. Resolve pending
   reservations explicitly. Preserve existing evidence and research the missing
   questions only. Coverage requires distinct sources, not multiple URLs for a DOI.
7. Reserve each focused follow-up with `reserve --gap-pass --json <array>` to check
   the budget and reserve the batch in one call. At most two are permitted;
   `allowed:false` means synthesize existing evidence with limitations. Stop sooner
   when questions are supported and further searching adds no meaningful evidence.
   Broader studies require an explicit wider scope, not hidden budget increases.
8. Never weaken a complex question to meet a count. Clearly state unresolved
   questions, inaccessible full text, conflicting findings and insufficient support.
   `synthesize_with_limitations` does not mean the original task is fully verified.

The checkpoint complements an optional `sources.json` / `source_matrix.py` audit;
it does not replace report citation checks or source-quality judgment. Use the
structured quality gate when the task calls for that audit, rather than saving a
second full report for every answer. Incomplete verification must remain explicit.

## Reuse evidence without rebuilding scripts

`research_state.py --db <task-db> export-sources --out <new-sources.json>` writes a
new UTF-8 file (refuses overwrite), containing `sources` with saved supported
claims and separate `candidates` that have not supplied content evidence. It does
not reread pages or generate a report. Enrich bibliographic dates/publishers only
from already verified results, then validate with source_matrix.py. Do not write
a custom temporary program to reconstruct the same ledger.

For PDF excerpts, record `level:"full_text_excerpt"` with relevant pages in the
finding/detail. This is actual full-text content for that claim, but not a whole
paper read; abstracts alone cannot satisfy a full-text question. `full_text`
requires complete extracted text, with any OCR/layout limitations disclosed.

A PDF reservation represents a logical paper read, not each pagination call.
Keep it pending while reading the relevant pages/cursors, then record findings
in one batch. Reuse means reuse content already obtained, not pretend unseen
methods/results were read. If a later question needs another section, continue
from the cached PDF without repeating discovery; annotate only newly observed
findings, including pages and partial-read limitations. Source-route budgets
must not be used to prohibit necessary pagination or to silently narrow a question.
