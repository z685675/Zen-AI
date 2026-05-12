# Sync Release To Ali

Recommended release flow:

1. Run the existing `Release` workflow to build artifacts and create/update a draft release.
2. Edit the draft release on GitHub and finalize the release notes there.
3. Publish the release.
4. Manually run the `Sync Release To Ali` workflow with the published tag.

Required GitHub Actions secrets:

- `ALI_SSH_HOST`
- `ALI_SSH_PORT`
- `ALI_SSH_USER`
- `ALI_SSH_KEY`
- `ALI_DEPLOY_PATH`

Expected NAS deploy path example:

```text
/opt/zen-ai-update/html/zen-ai
```

What the sync workflow does:

1. Downloads the published release assets from GitHub Releases.
2. Reads the final GitHub Release body.
3. Writes that body into `latest*.yml` as `releaseNotes`.
4. Uploads the updated assets and metadata to the NAS directory.

This keeps GitHub Release notes, in-app update notes, and NAS-hosted update metadata aligned.
