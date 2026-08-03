// Deterministic, length-preserving token substitution shared by the fixture
// scrubber (§5.2). Seed-stable: the SAME original token always yields the SAME
// replacement across all four files, so cross-file identity survives — the BNP
// RIB stays equal across statements, refs dedupe, name-prefix pairing hints hold.

function hash32(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function prng(seed: number): () => number {
  let s = seed || 1
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

const cache = new Map<string, string>()

/** Replace each digit with a pseudo-random digit; length preserved, deterministic. */
export function scrubDigits(run: string): string {
  const key = 'd:' + run
  const cached = cache.get(key)
  if (cached) return cached
  const rnd = prng(hash32(run))
  const out = [...run].map((ch) => (/\d/.test(ch) ? String(Math.floor(rnd() * 10)) : ch)).join('')
  cache.set(key, out)
  return out
}

const VOWELS = 'AEIOU'
const CONS = 'BCDFGHJKLMNPRSTVWXZ'

/** Replace an uppercase name word with a pronounceable same-length fake (case preserved). */
export function scrubName(word: string): string {
  const key = 'n:' + word.toUpperCase()
  const cached = cache.get(key)
  if (cached) {
    // reapply the source casing
    return applyCase(word, cached)
  }
  const rnd = prng(hash32(word.toUpperCase()))
  let out = ''
  for (let i = 0; i < word.length; i++) {
    const ch = word[i]!
    if (!/[A-Za-z]/.test(ch)) {
      out += ch
      continue
    }
    out += i % 2 === 0 ? CONS[Math.floor(rnd() * CONS.length)]! : VOWELS[Math.floor(rnd() * VOWELS.length)]!
  }
  cache.set(key, out)
  return applyCase(word, out)
}

const VOWELS_UK = 'АЕИІОУЮЯ'
const CONS_UK = 'БВГДЖЗКЛМНПРСТФХЦЧШ'

/**
 * The Cyrillic twin of `scrubName`, for PUMB's `Клієнт` line. Same contract — deterministic,
 * length- and case-preserving — so the header block keeps its geometry and the account's holder
 * signal stays a stable, distinct value across every file of that account.
 */
export function scrubCyrillicName(word: string): string {
  const key = 'c:' + word.toUpperCase()
  const cached = cache.get(key)
  if (cached) return applyCaseUk(word, cached)
  const rnd = prng(hash32(word.toUpperCase()))
  let out = ''
  for (let i = 0; i < word.length; i++) {
    const ch = word[i]!
    if (!/[Ѐ-ӿ]/.test(ch)) {
      out += ch
      continue
    }
    out += i % 2 === 0 ? CONS_UK[Math.floor(rnd() * CONS_UK.length)]! : VOWELS_UK[Math.floor(rnd() * VOWELS_UK.length)]!
  }
  cache.set(key, out)
  return applyCaseUk(word, out)
}

function applyCaseUk(src: string, fake: string): string {
  let out = ''
  for (let i = 0; i < src.length; i++) {
    const s = src[i]!
    const f = fake[i] ?? s
    out += s === s.toLowerCase() && s !== s.toUpperCase() ? f.toLowerCase() : f.toUpperCase()
  }
  return out
}

function applyCase(src: string, fake: string): string {
  let out = ''
  for (let i = 0; i < src.length; i++) {
    const s = src[i]!
    const f = fake[i] ?? s
    out += /[a-z]/.test(s) ? f.toLowerCase() : f.toUpperCase()
  }
  return out
}
