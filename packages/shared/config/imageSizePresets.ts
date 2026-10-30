// Shared by local paintings and the workbench. Keep this deliberately smaller
// than the accepted dimensions, which also include legacy task parameters.
export const commonImageSizePresets: ReadonlyArray<{ size: string; isExperimental?: boolean }> = [
  { size: 'auto' },
  { size: '1024x1024' },
  { size: '1536x1024' },
  { size: '1024x1536' },
  { size: '2048x2048' },
  { size: '2560x1440' },
  { size: '1440x2560' },
  { size: '2880x2880', isExperimental: true },
  { size: '3072x2048', isExperimental: true },
  { size: '2048x3072', isExperimental: true },
  { size: '3840x2160', isExperimental: true },
  { size: '2160x3840', isExperimental: true }
]
