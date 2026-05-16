declare global {
  namespace Electron {
    interface App {
      isQuitting: boolean
      isInstallingUpdate?: boolean
    }
  }
}

export {}
