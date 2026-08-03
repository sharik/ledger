/** Minimal promise wrapper over one IndexedDB key-value store. */
export class KV {
  private constructor(private db: IDBDatabase) {}

  static open(name = 'ledger'): Promise<KV> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1)
      req.onupgradeneeded = () => req.result.createObjectStore('kv')
      req.onsuccess = () => resolve(new KV(req.result))
      req.onerror = () => reject(req.error)
    })
  }

  get<T>(key: string): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      const req = this.db.transaction('kv', 'readonly').objectStore('kv').get(key)
      req.onsuccess = () => resolve(req.result as T | undefined)
      req.onerror = () => reject(req.error)
    })
  }

  put(key: string, value: unknown): Promise<void> {
    return this.putMany({ [key]: value })
  }

  /** All entries commit in ONE transaction — the §2.2 crash-safety guarantee. */
  putMany(entries: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('kv', 'readwrite')
      const store = tx.objectStore('kv')
      for (const [k, v] of Object.entries(entries)) store.put(v, k)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  }

  delete(key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('kv', 'readwrite')
      tx.objectStore('kv').delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }

  close(): void {
    this.db.close()
  }

  static destroy(name = 'ledger'): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(name)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
      req.onblocked = () => resolve()
    })
  }
}
