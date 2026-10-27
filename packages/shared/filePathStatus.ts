export type FilePathStatus = 'available' | 'missing' | 'unavailable'

export type FilePathCheck = { path: string; status: FilePathStatus }
