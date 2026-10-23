export type Project = 'ai' | 'api'
export type Mode = 'inventory' | 'changed' | 'offline' | 'release' | 'live'
export type CaseStatus =
  | 'planned'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'not_run'
  | 'environment_blocked'
  | 'review_required'
  | 'cancelled'
export type Executor = 'vitest' | 'script' | 'go-test' | 'go-vet' | 'api-web'

export interface Check {
  id: string
  project: Project
  title: string
  executor: Executor
  target: string[]
  modes: Array<'offline' | 'release'>
  tags: string[]
  timeoutMs: number
}

export interface ManualCase {
  id: string
  tags: string[]
  title: string
  steps: string[]
  prompt: string
  expected: string
  reason: string
}

export interface ImpactRule {
  project: Project
  prefixes: string[]
  tags: string[]
}

export interface Manifest {
  schemaVersion: 1
  checks: Check[]
  rules: ImpactRule[]
  manual: ManualCase[]
  mappingError?: string
}

export interface Revision {
  head: string | null
  base: string | null
  dirty: boolean | null
  changedPaths: string[]
  changeDigest: string | null
  error?: string
}

export interface Selection {
  project: Project
  tags: string[]
  reasons: string[]
  fallbackToFull: boolean
  checkIds: string[]
}

export interface TestCounts {
  passed: number
  failed: number
  skipped: number
  pending: number
}

export interface CheckResult {
  id: string
  project: Project
  title: string
  status: CaseStatus
  durationMs: number
  exitCode?: number | null
  signal?: string | null
  timedOut?: boolean
  outputTruncated?: boolean
  tests?: TestCounts
  detail?: string
  warnings?: string[]
  evidence: string[]
}

export interface Inventory {
  project: Project
  available: boolean
  testFiles: number
  scripts: string[]
  workflows: string[]
  limitations: string[]
}

export interface QualityReport {
  schemaVersion: 1
  runId: string
  mode: Mode
  dryRun: boolean
  startedAt: string
  finishedAt: string | null
  environment: { platform: string; arch: string; node: string; packaged: boolean }
  network: { paidCallsAuthorized: boolean; credentialsInherited: false; osSandbox: false }
  revisions: Partial<Record<Project, Revision>>
  finalRevisions?: Partial<Record<Project, Revision>>
  inventory: Inventory[]
  selection: Selection[]
  cases: CheckResult[]
  summary: Record<CaseStatus, number>
  manualRequired: ManualCase[]
  limitations: string[]
  livePlan?: unknown
  liveResult?: unknown
  outcome: 'planned' | 'passed' | 'failed' | 'incomplete' | 'cancelled'
}
