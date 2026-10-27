export type OpenCodeAgentMode = 'plan' | 'build'

// Keep persisted legacy values compatible without rewriting session history.
// The native agent name, permissions and UI must agree on this mapping.
export function getOpenCodeAgentMode(permissionMode?: string | null): OpenCodeAgentMode {
  return permissionMode === 'plan' ? 'plan' : 'build'
}
