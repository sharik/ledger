import { KV } from './idb'

export type RemoteConfig =
  | { kind: 'none' }
  | { kind: 'localFile'; handle: FileSystemFileHandle }
  | { kind: 'gdrive'; fileId: string; fileName: string }
  | { kind: 'httpTest'; name: string }

/** Typed access to the L1 keys (SYNC §2.2 / spec §4.4). */
export class LocalStore {
  constructor(readonly kv: KV) {}

  getBlob(): Promise<ArrayBuffer | undefined> {
    return this.kv.get('vault.blob')
  }
  getLocalRevision(): Promise<number> {
    return this.kv.get<number>('vault.localRevision').then((v) => v ?? 0)
  }
  getPendingWrite(): Promise<boolean> {
    return this.kv.get<boolean>('sync.pendingWrite').then((v) => v ?? false)
  }
  getLastSyncedRevision(): Promise<string | null> {
    return this.kv.get<string>('sync.lastSyncedRevision').then((v) => v ?? null)
  }
  getLastSyncedBase(): Promise<ArrayBuffer | undefined> {
    return this.kv.get('sync.lastSyncedBase')
  }
  getRemote(): Promise<RemoteConfig> {
    return this.kv.get<RemoteConfig>('sync.remote').then((v) => v ?? { kind: 'none' })
  }
  getSaltCache(): Promise<ArrayBuffer | undefined> {
    return this.kv.get('crypto.saltCache')
  }

  /** The write-ahead save transaction: blob + revision + pendingWrite atomically. */
  async saveVaultBlob(blob: Uint8Array): Promise<number> {
    const rev = (await this.getLocalRevision()) + 1
    await this.kv.putMany({
      'vault.blob': blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength),
      'vault.localRevision': rev,
      'sync.pendingWrite': true,
    })
    return rev
  }

  /** Successful sync commit (SYNC §3.4 commit(rev)). */
  commitSync(rev: string, base: Uint8Array): Promise<void> {
    return this.kv.putMany({
      'sync.lastSyncedRevision': rev,
      'sync.lastSyncedBase': base.buffer.slice(base.byteOffset, base.byteOffset + base.byteLength),
      'sync.pendingWrite': false,
    })
  }

  setLastSyncedBase(base: Uint8Array): Promise<void> {
    return this.kv.put('sync.lastSyncedBase', base.buffer.slice(base.byteOffset, base.byteOffset + base.byteLength))
  }

  setRemote(remote: RemoteConfig): Promise<void> {
    return this.kv.putMany({ 'sync.remote': remote, 'sync.lastSyncedRevision': null, 'sync.lastSyncedBase': null })
  }

  setSaltCache(salt: Uint8Array): Promise<void> {
    return this.kv.put('crypto.saltCache', salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength))
  }
}
