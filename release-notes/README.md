# Release Notes

Create one Markdown file per version to control the update notes shown inside the app.

Recommended naming:

- `release-notes/v1.1.7.md`
- `release-notes/v1.1.8.md`

Behavior:

- The release workflow reads `release-notes/<tag>.md` first.
- If that file does not exist, it falls back to the annotated git tag message.
- The same notes are written into GitHub Release body and `dist/latest*.yml`.

## In-app, offline release history

The About page opens a local version browser. `resources/release-history.json`
contains an offline snapshot of published stable GitHub releases. It is created
with `node scripts/build-release-history.js --input releases.json --output resources/release-history.json`.
The input may be a release array or the paginated output of
`gh api --paginate --slurp repos/z685675/Zen-AI/releases?per_page=100`.
Drafts, prereleases and records without a publication date are excluded.

Installer CI fetches the latest published history into the ignored file
`resources/release-history.generated.json` before building. This avoids modifying
the release commit or invalidating the hotpatch baseline. Only the installed
version may use its Markdown file as an explicitly labelled offline fallback;
other unpublished Markdown versions do not appear in the browser.

On publication, `sync-release-to-nas.yml` reads the final GitHub Release bodies
and writes `release-history.json` beside `latest*.yml` on the download server.
The current selected release must be published and stable before download
metadata can change. `RELEASE_HISTORY_JSON_PATH` supplies the paginated history
to `scripts/sync-release-metadata.js`.

The client loads bundled/cached notes immediately, then refreshes in the
background when the browser opens. Final published wording replaces installer
previews, and fetched versions remain cached across restarts and upgrades at
`{userData}/Data/release-history/history.json`. Network/validation failures keep
the previous records; manual refresh can retry immediately. This adds no startup
network wait and does not change the installer download/update decision.

Example:

```md
1. Fixed provider import flow after one-click import.
2. Synced global model and chat model after import.
3. Improved update reminder behavior when auto download is disabled.
```
