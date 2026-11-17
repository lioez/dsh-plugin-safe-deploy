export type DeployTarget = 'auto' | 'cloudflare'
export type ModeRequest = 'auto' | 'temporary' | 'account'
export type DeployMode = 'temporary' | 'account'

export interface DeployArgs {
  directory?: string
  target?: DeployTarget
  mode?: ModeRequest
  /** Only inspect and report; never deploy. */
  preflight?: boolean
  /** Fingerprint returned by a previous preflight; required to proceed. */
  confirm?: string
}

export type PreflightCheckLevel = 'pass' | 'warn' | 'block'

export interface PreflightCheck {
  id: string
  ok: boolean
  level: PreflightCheckLevel
  detail: string
}

export interface PreflightSummaryItem {
  path: string
  files: number
  bytes: number
}

export interface DeployResult {
  ok: boolean
  mode: DeployMode | 'none'
  previewUrl?: string
  claimUrl?: string
  claimWithin?: string
  workerName?: string
  warnings: string[]
  error?: string
  hint?: string
  stdout?: string
  exitCode?: number
  preflight?: boolean
  projectKind?: string
  assetsRoot?: string
  fileCount?: number
  totalBytes?: number
  fingerprint?: string
  blocked?: string[]
  review?: string[]
  checks?: PreflightCheck[]
  topLevel?: PreflightSummaryItem[]
}

export interface PreflightResult extends DeployResult {
  preflight: true
  projectKind: string
  assetsRoot: string
  fileCount: number
  totalBytes: number
  fingerprint: string
  blocked: string[]
  review: string[]
  checks: PreflightCheck[]
  topLevel: PreflightSummaryItem[]
}

export interface DeployExec {
  agent?: unknown
  signal: AbortSignal
  callId?: string
}
