export const researchWorkspace = {
  enabled: true
}

export const isResearchWorkspaceEnabled = (enableDeveloperMode: boolean) => {
  return researchWorkspace.enabled && enableDeveloperMode
}
