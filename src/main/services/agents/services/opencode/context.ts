import type { ModelTokenMetadata } from '../../../../../../packages/shared/modelCapacity'
import { resolveModelTokenLimits } from '../../../../../../packages/shared/utils/modelTokenLimits'

/** Match the pinned native runtime's output ceiling and compaction reserve. */
export function resolveOpenCodeContext(model?: ModelTokenMetadata) {
  const { context, input = context, output } = resolveModelTokenLimits(model)
  const nativeOutput = Math.min(output, 32_000)
  // A separate input limit already excludes output. Leave headroom inside it,
  // while also respecting the total window; do not subtract output twice.
  const available = Math.min(input, context - nativeOutput)
  const headroom = Math.min(8_000, Math.floor(available / 4))
  const reserved = Math.min(input - 1, input - available + headroom)
  return { context, input, output, reserved, usableInput: input - reserved }
}
