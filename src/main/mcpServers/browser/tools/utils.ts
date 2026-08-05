export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export const BROWSER_TOOL_TIMEOUT_MS = 45_000

export async function withBrowserToolTimeout<T>(
  operation: Promise<T>,
  timeoutMs = BROWSER_TOOL_TIMEOUT_MS
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`Browser tool timed out after ${Math.round(timeoutMs / 1000)} seconds`)),
          timeoutMs
        )
      })
    ])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

export function successResponse(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    isError: false
  }
}

export function imageResponse(base64: string, mimeType = 'image/png') {
  return {
    content: [{ type: 'image' as const, data: base64, mimeType }],
    isError: false
  }
}

export function errorResponse(error: Error | string) {
  const message = error instanceof Error ? error.message : error
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true
  }
}
