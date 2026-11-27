import { combineReducers, configureStore, createSlice } from '@reduxjs/toolkit'
import { persistReducer, persistStore } from 'redux-persist'
import type storageAdapter from 'redux-persist/lib/storage'
import { describe, expect, it, vi } from 'vitest'

import { isPrimaryStoreWindow, readOnlyPersistStorage } from '../persistence'

describe('Redux persistence ownership', () => {
  it('selects the main renderer in development and packaged builds', () => {
    for (const pathname of ['/', '/index.html', '/C:/Zen-AI/resources/app.asar/out/renderer/index.html']) {
      expect(isPrimaryStoreWindow(pathname)).toBe(true)
    }
    for (const entry of ['miniWindow', 'selectionToolbar', 'selectionAction', 'traceWindow']) {
      expect(isPrimaryStoreWindow(`/${entry}.html`)).toBe(false)
    }
  })

  it('rehydrates secondary stores without overwriting a newer snapshot owned by the main renderer', async () => {
    const records = new Map<string, string>()
    const storage = {
      getItem: vi.fn(async (key: string) => records.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => records.set(key, value)),
      removeItem: vi.fn(async (key: string) => records.delete(key))
    }
    const settings = createSlice({
      name: 'settings',
      initialState: { enabled: false },
      reducers: {
        enable: (state) => {
          state.enabled = true
        }
      }
    })
    const mcp = createSlice({
      name: 'mcp',
      initialState: { name: '' },
      reducers: {
        rename: (state, action: { payload: string }) => {
          state.name = action.payload
        }
      }
    })
    const reducer = combineReducers({ settings: settings.reducer, mcp: mcp.reducer })
    const open = async (adapter: typeof storageAdapter) => {
      const store = configureStore({
        reducer: persistReducer({ key: 'test', storage: adapter }, reducer),
        middleware: (getDefault) => getDefault({ serializableCheck: false })
      })
      const ready = Promise.withResolvers<void>()
      const persistor = persistStore(store, undefined, ready.resolve)
      await ready.promise
      return { store, persistor }
    }

    const primary = await open(storage)
    primary.store.dispatch(mcp.actions.rename('historical'))
    await primary.persistor.flush()
    const secondary = await open(readOnlyPersistStorage(storage))
    expect(secondary.store.getState().mcp.name).toBe('historical')

    primary.store.dispatch(mcp.actions.rename('current'))
    primary.store.dispatch(settings.actions.enable())
    await primary.persistor.flush()
    storage.setItem.mockClear()
    secondary.store.dispatch(settings.actions.enable())
    await secondary.persistor.flush()
    await secondary.persistor.purge()
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled()

    const reopened = await open(storage)
    expect(reopened.store.getState()).toMatchObject({ mcp: { name: 'current' }, settings: { enabled: true } })
    for (const { persistor } of [primary, secondary, reopened]) {
      await persistor.flush()
      persistor.pause()
    }
  })
})
