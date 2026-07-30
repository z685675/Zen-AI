export type ContextResourceKind = 'text' | 'document' | 'image' | 'tool-result'
export type ContextResourceStatus = 'pending' | 'ready' | 'failed'

export type ContextResourceChunk = {
  id: string
  index: number
  text: string
  tokenEstimate: number
  metadata?: Record<string, unknown>
}

export type ContextResource = {
  id: string
  conversationId: string
  sourceMessageId?: string
  kind: ContextResourceKind
  contentHash: string
  sourceName: string
  status: ContextResourceStatus
  tokenEstimate: number
  chunks: ContextResourceChunk[]
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type ContextResourceSearchResult = {
  resourceId: string
  sourceName: string
  chunk: ContextResourceChunk
  score: number
  lexicalScore?: number
  semanticScore?: number
}

export type StructuredFileSection = {
  text: string
  metadata: {
    page?: number
    slide?: number
    sheet?: string
    cellRange?: string
    table?: number
    section?: string
  }
}

export type StructuredFileContent = {
  parserVersion: number
  format: string
  sections: StructuredFileSection[]
}

export type ContextProcessingStatus =
  | 'idle'
  | 'analyzing'
  | 'extracting'
  | 'compacting'
  | 'retrieving'
  | 'retrying'
  | 'complete'
  | 'error'

export type ContextTelemetry = {
  conversationId: string
  status: ContextProcessingStatus
  detail?: string
  processedItems: number
  totalItems: number
  compressionCount: number
  retrievalCount: number
  retrievedChunks: number
  retryCount: number
  resourceCount: number
  cacheHits: number
  cacheMisses: number
  lastAction?: string
  lastError?: string
  updatedAt: string
}
