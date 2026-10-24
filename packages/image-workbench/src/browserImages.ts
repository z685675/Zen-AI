// Adapted from dsh-image-gen/src/client/browser-image-utils.ts at
// a961b7f476af651736afa6ab42b795c8e0aa9dc7. Copyright 2026 shanliuling.
// Apache-2.0 (see ../LICENSE-DSH). Modified: typed conversion for the Zen sandbox.
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('image_read_failed'))
    reader.readAsDataURL(blob)
  })
}
