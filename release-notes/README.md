# Release Notes

Create one Markdown file per version to control the update notes shown inside the app.

Recommended naming:

- `release-notes/v1.1.7.md`
- `release-notes/v1.1.8.md`

Behavior:

- The release workflow reads `release-notes/<tag>.md` first.
- If that file does not exist, it falls back to the annotated git tag message.
- The same notes are written into GitHub Release body and `dist/latest*.yml`.

Example:

```md
1. Fixed provider import flow after one-click import.
2. Synced global model and chat model after import.
3. Improved update reminder behavior when auto download is disabled.
```
