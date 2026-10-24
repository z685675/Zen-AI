import type { ImageCanvasExpansion } from '@shared/config/imageCanvas'

export type WorkbenchDraft = {
  providerId: string
  modelId: string
  prompt: string
  references: string[]
  dimension: string
  quality: string
  background: string
  count: number
  mask?: string
  expansion?: ImageCanvasExpansion
  comparisons?: Array<{ providerId: string; modelId: string }>
}

export const emptyDraft: WorkbenchDraft = {
  providerId: '',
  modelId: '',
  prompt: '',
  references: [],
  dimension: '',
  quality: 'auto',
  background: 'auto',
  count: 1
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('zen-image-workbench', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('drafts')
    request.onerror = () => reject(new Error('draft_storage_failed'))
    request.onsuccess = () => resolve(request.result)
  })
}

export async function readDraft(): Promise<WorkbenchDraft> {
  const db = await database()
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('drafts').objectStore('drafts').get('current')
      request.onsuccess = () => {
        const value = request.result
        resolve(
          value && typeof value.prompt === 'string' && Array.isArray(value.references)
            ? { ...emptyDraft, ...value }
            : { ...emptyDraft }
        )
      }
      request.onerror = () => reject(new Error('draft_storage_failed'))
    })
  } finally {
    db.close()
  }
}

let writes = Promise.resolve()
export function writeDraft(draft: WorkbenchDraft): Promise<void> {
  const snapshot = structuredClone(draft)
  const next = writes.catch(() => undefined).then(() => persistDraft(snapshot))
  writes = next
  return next
}

async function persistDraft(draft: WorkbenchDraft): Promise<void> {
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('drafts', 'readwrite')
      transaction.objectStore('drafts').put(draft, 'current')
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(new Error('draft_storage_failed'))
      transaction.onabort = () => reject(new Error('draft_storage_failed'))
    })
  } finally {
    db.close()
  }
}
