/** Remote storage contract (SYNC §3.4). Revisions are adapter-opaque strings. */
export interface RemoteMetadata {
  revision: string
}

export interface RemoteAdapter {
  /** null = nothing stored yet. Must be CHEAP — it runs on every focus/poll. */
  getMetadata(): Promise<RemoteMetadata | null>
  read(): Promise<{ bytes: Uint8Array; revision: string }>
  /**
   * ifRevision present → compare-and-swap: throw RevisionConflictError if the
   * remote moved. ifRevision absent → create-only: throw if anything exists.
   */
  write(bytes: Uint8Array, opts: { ifRevision?: string }): Promise<{ revision: string }>
  /** Side-channel files (vault.corrupt.bak). Optional. */
  writeAux?(name: string, bytes: Uint8Array): Promise<void>
}

export class RevisionConflictError extends Error {
  constructor() {
    super('remote revision moved')
    this.name = 'RevisionConflictError'
  }
}

/** Expired/revoked auth on future OAuth adapters → REAUTH_NEEDED. */
export class RemoteAuthError extends Error {
  constructor() {
    super('remote auth needed')
    this.name = 'RemoteAuthError'
  }
}

/** 5xx / network flake → ERROR_BACKOFF, not data loss. */
export class RemoteTransientError extends Error {
  constructor(msg = 'remote temporarily unavailable') {
    super(msg)
    this.name = 'RemoteTransientError'
  }
}
