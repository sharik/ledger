import { beforeAll, describe, expect, it } from 'vitest'
import { webcrypto } from 'node:crypto'
import { setFixedNow } from '../src/model/clock'
import { seedVault } from '../src/model/seed'
import { SCHEMA_VERSION } from '../src/model/types'
import {
  b64,
  decryptClassify,
  deriveKey,
  encodeVault,
  encryptBlob,
  makeHeader,
  newSalt,
  parseBlob,
  unlockBlob,
  type KdfParams,
} from '../src/persist/crypto'

if (!globalThis.crypto?.subtle) {
  // node's webcrypto for the test environment
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto })
}

const TEST_KDF: KdfParams = { m: 64, t: 1, p: 1 }

beforeAll(() => setFixedNow('2026-07-09T12:00:00Z'))

describe('vault crypto', () => {
  it('roundtrips a vault through encrypt/unlock', async () => {
    const vault = seedVault()
    const salt = newSalt()
    const key = await deriveKey('correct horse', salt, TEST_KDF)
    const header = makeHeader(vault.vaultId, salt, TEST_KDF)
    const blob = await encryptBlob(encodeVault(vault), key, header)

    const res = await unlockBlob(blob, 'correct horse', TEST_KDF)
    expect(res.kind).toBe('ok')
    if (res.kind === 'ok') expect(res.vault.vaultId).toBe(vault.vaultId)
  })

  it('wrong password fails cleanly', async () => {
    const vault = seedVault()
    const salt = newSalt()
    const key = await deriveKey('right', salt, TEST_KDF)
    const blob = await encryptBlob(encodeVault(vault), key, makeHeader(vault.vaultId, salt, TEST_KDF))
    const res = await unlockBlob(blob, 'wrong', TEST_KDF)
    expect(res.kind).toBe('wrongPassword')
  })

  it('uses a fresh IV per encrypt', async () => {
    const vault = seedVault()
    const salt = newSalt()
    const key = await deriveKey('pw', salt, TEST_KDF)
    const header = makeHeader(vault.vaultId, salt, TEST_KDF)
    const b1 = await encryptBlob(encodeVault(vault), key, header)
    const b2 = await encryptBlob(encodeVault(vault), key, header)
    const iv = (b: Uint8Array) => b64(parseBlob(b)!.iv)
    expect(iv(b1)).not.toBe(iv(b2))
    // whole ciphertext differs too (byte compare — avoids spreading a large blob)
    expect(b1.length === b2.length && b1.every((v, i) => v === b2[i])).toBe(false)
  })

  it('blob starts with the LGR1 magic', async () => {
    const vault = seedVault()
    const salt = newSalt()
    const key = await deriveKey('pw', salt, TEST_KDF)
    const blob = await encryptBlob(encodeVault(vault), key, makeHeader(vault.vaultId, salt, TEST_KDF))
    expect(new TextDecoder().decode(blob.slice(0, 4))).toBe('LGR1')
  })

  describe('remote blob classification', () => {
    async function fixture() {
      const vault = seedVault()
      const salt = newSalt()
      const key = await deriveKey('pw', salt, TEST_KDF)
      const header = makeHeader(vault.vaultId, salt, TEST_KDF)
      const blob = await encryptBlob(encodeVault(vault), key, header)
      return { vault, salt, key, header, blob }
    }

    it('ok: same salt, valid tag', async () => {
      const f = await fixture()
      expect((await decryptClassify(f.blob, f.key, f.salt)).kind).toBe('ok')
    })

    it('rekeyed: header salt differs from cached salt', async () => {
      const f = await fixture()
      const otherSalt = newSalt()
      const res = await decryptClassify(f.blob, f.key, otherSalt)
      expect(res.kind).toBe('rekeyed')
    })

    it('corrupt: same salt but a flipped ciphertext bit', async () => {
      const f = await fixture()
      const damaged = new Uint8Array(f.blob)
      damaged[damaged.length - 20]! ^= 0xff
      expect((await decryptClassify(damaged, f.key, f.salt)).kind).toBe('corrupt')
    })

    it('corrupt: tampered header (AAD) invalidates the tag', async () => {
      const f = await fixture()
      // Rewrite a header byte without touching salt: header JSON contains vaultId — flip a char in it.
      const parsed = parseBlob(f.blob)!
      const headerStr = new TextDecoder().decode(parsed.headerBytes)
      const tampered = headerStr.replace(f.vault.vaultId.slice(0, 4), 'dead')
      const tb = new TextEncoder().encode(tampered)
      const out = new Uint8Array(f.blob.length + (tb.length - parsed.headerBytes.length))
      out.set(f.blob.slice(0, 4), 0)
      new DataView(out.buffer).setUint16(4, tb.length, false)
      out.set(tb, 6)
      out.set(f.blob.slice(6 + parsed.headerBytes.length), 6 + tb.length)
      expect((await decryptClassify(out, f.key, f.salt)).kind).toBe('corrupt')
    })

    it('schemaNewer: decrypts but flags a newer schema', async () => {
      const f = await fixture()
      const future = { ...f.vault, schema: SCHEMA_VERSION + 1 }
      const blob = await encryptBlob(encodeVault(future), f.key, f.header)
      expect((await decryptClassify(blob, f.key, f.salt)).kind).toBe('schemaNewer')
    })

    it('corrupt: garbage bytes', async () => {
      const f = await fixture()
      expect((await decryptClassify(new Uint8Array([1, 2, 3]), f.key, f.salt)).kind).toBe('corrupt')
    })
  })
})
