import type storageAdapter from 'redux-persist/lib/storage'

type PersistStorage = typeof storageAdapter

export function isPrimaryStoreWindow(pathname: string): boolean {
  return pathname === '/' || pathname.endsWith('/index.html')
}

export function readOnlyPersistStorage(storage: PersistStorage): PersistStorage {
  return {
    getItem: (key) => storage.getItem(key),
    setItem: async () => undefined,
    removeItem: async () => undefined
  }
}
