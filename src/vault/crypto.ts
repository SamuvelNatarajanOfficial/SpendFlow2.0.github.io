/**
 * Cryptographic primitives. Web Crypto API only: no custom algorithms, no fallbacks.
 *
 *  KDF:    PBKDF2-HMAC-SHA-256 -> AES-256-GCM key (non-extractable CryptoKey)
 *  Cipher: AES-256-GCM, 128-bit tag, fresh random 96-bit nonce per encryption, AAD-bound
 *
 * Nothing in this file touches storage or the UI.
 */

type Bytes = Uint8Array<ArrayBuffer>

/**
 * KDF policy. `minIterations` follows the OWASP Password Storage Cheat Sheet (2023) figure of 600,000 for
 * PBKDF2-HMAC-SHA-256. The default is calibrated per device between min and max so that unlocking takes roughly
 * `targetMs`. `acceptMin`/`acceptMax` bound values read from storage or from a backup file, so a tampered file
 * cannot force an absurd amount of work (DoS) or silently weaken derivation.
 * Tests may lower the numbers; production code never does.
 */
export const PRODUCTION_KDF_POLICY = Object.freeze({
  minIterations: 600_000,
  maxIterations: 2_500_000,
  targetMs: 750,
  acceptMin: 100_000,
  acceptMax: 10_000_000,
})
export const kdfPolicy: { -readonly [K in keyof typeof PRODUCTION_KDF_POLICY]: number } = { ...PRODUCTION_KDF_POLICY }

export const SALT_BYTES = 16
export const NONCE_BYTES = 12
const TAG_BITS = 128

export class CryptoUnsupportedError extends Error {}
/** Raised for ANY decryption/authentication failure. Deliberately generic: wrong key and tampering look identical. */
export class CryptoAuthError extends Error {
  constructor() {
    super('Decryption failed')
  }
}

export function cryptoSupport(): { ok: true } | { ok: false; reason: string } {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (!c || !c.subtle || typeof c.getRandomValues !== 'function') {
    return { ok: false, reason: 'This browser does not provide the Web Crypto API.' }
  }
  if ((globalThis as { isSecureContext?: boolean }).isSecureContext === false) {
    return { ok: false, reason: 'Encryption requires a secure context (HTTPS or localhost).' }
  }
  return { ok: true }
}

function subtle(): SubtleCrypto {
  const s = cryptoSupport()
  if (!s.ok) throw new CryptoUnsupportedError(s.reason)
  return globalThis.crypto.subtle
}

/** Cryptographically secure random bytes (crypto.getRandomValues). */
export function randomBytes(n: number): Bytes {
  const s = cryptoSupport()
  if (!s.ok) throw new CryptoUnsupportedError(s.reason)
  const b = new Uint8Array(n)
  globalThis.crypto.getRandomValues(b)
  return b
}

const utf8 = new TextEncoder()
const utf8d = new TextDecoder('utf-8', { fatal: true })
export const encodeText = (s: string): Bytes => utf8.encode(s)
export const decodeText = (b: Uint8Array): string => utf8d.decode(b)

const B64 = /^[A-Za-z0-9+/]*={0,2}$/
export function toB64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s)
}
export function fromB64(s: string): Bytes {
  if (typeof s !== 'string' || s.length % 4 !== 0 || !B64.test(s)) throw new Error('Invalid base64')
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// ---------- key derivation ----------

export interface KdfParams {
  name: 'PBKDF2'
  hash: 'SHA-256'
  iterations: number
  salt: Uint8Array
}

export function assertKdfAcceptable(p: Pick<KdfParams, 'iterations' | 'salt'>): void {
  if (!Number.isInteger(p.iterations) || p.iterations < kdfPolicy.acceptMin || p.iterations > kdfPolicy.acceptMax) {
    throw new CryptoAuthError()
  }
  if (p.salt.length < SALT_BYTES || p.salt.length > 64) throw new CryptoAuthError()
}

/** Creation-time floor (stricter than the acceptance floor used when reading existing data). */
export function assertKdfStrongEnough(iterations: number): void {
  if (!Number.isInteger(iterations) || iterations < kdfPolicy.minIterations || iterations > kdfPolicy.acceptMax) {
    throw new Error(`KDF iterations must be at least ${kdfPolicy.minIterations}`)
  }
}

export function newKdfParams(iterations: number): KdfParams {
  assertKdfStrongEnough(iterations)
  return { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: randomBytes(SALT_BYTES) }
}

/**
 * Derives a NON-EXTRACTABLE AES-256-GCM key. The password is NFKC-normalised so the same passphrase typed on
 * different keyboards/OSes derives the same key. The temporary byte copy is zeroed (best effort: JS strings and
 * engine internals may retain other copies; this cannot be guaranteed).
 */
export async function deriveKey(password: string, p: KdfParams): Promise<CryptoKey> {
  assertKdfAcceptable(p)
  const pw = encodeText(password.normalize('NFKC'))
  try {
    const base = await subtle().importKey('raw', pw, 'PBKDF2', false, ['deriveKey'])
    return await subtle().deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: p.salt as Bytes, iterations: p.iterations },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
  } finally {
    pw.fill(0)
  }
}

/** Pure helper: pick an iteration count from a measured speed (ms per 100k iterations), clamped to policy. */
export function chooseIterations(msPer100k: number, policy = kdfPolicy): number {
  if (!Number.isFinite(msPer100k) || msPer100k <= 0) return policy.minIterations
  const raw = (100_000 * policy.targetMs) / msPer100k
  const rounded = Math.round(raw / 10_000) * 10_000
  return Math.max(policy.minIterations, Math.min(policy.maxIterations, rounded))
}

/** Measures this device and returns an iteration count targeting ~kdfPolicy.targetMs (never below the floor). */
export async function calibrateIterations(): Promise<number> {
  const s = subtle()
  const base = await s.importKey('raw', randomBytes(16), 'PBKDF2', false, ['deriveBits'])
  const t0 = performance.now()
  await s.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: randomBytes(SALT_BYTES), iterations: 100_000 }, base, 256)
  return chooseIterations(performance.now() - t0)
}

// ---------- AES-GCM ----------

/**
 * Guarantees no nonce repeats within a key session. Nonces are random 96-bit values (NIST SP 800-38D allows up to
 * 2^32 random-nonce encryptions per key); the guard additionally rejects any in-session repeat. Across sessions the
 * same key is re-derived, so uniqueness rests on randomness: at the scale of a personal ledger the collision
 * probability is negligible (< 2^-60 for 1 million encryptions).
 */
export class NonceGuard {
  private seen = new Set<string>()
  next(): Bytes {
    for (let i = 0; i < 8; i++) {
      const n = randomBytes(NONCE_BYTES)
      const k = toB64(n)
      if (!this.seen.has(k)) {
        this.seen.add(k)
        return n
      }
    }
    throw new Error('Random number generator failure')
  }
}

export async function encrypt(key: CryptoKey, plaintext: Uint8Array, aad: Uint8Array, guard: NonceGuard): Promise<{ iv: Bytes; ct: Bytes }> {
  const iv = guard.next()
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad as Bytes, tagLength: TAG_BITS }, key, plaintext as Bytes)
  return { iv, ct: new Uint8Array(ct) }
}

/** Verifies the GCM tag (incl. AAD) and decrypts. Any failure throws the generic CryptoAuthError. */
export async function decrypt(key: CryptoKey, iv: Uint8Array, ct: Uint8Array, aad: Uint8Array): Promise<Bytes> {
  try {
    if (iv.length !== NONCE_BYTES || ct.length < TAG_BITS / 8) throw new Error('bad shape')
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: iv as Bytes, additionalData: aad as Bytes, tagLength: TAG_BITS }, key, ct as Bytes))
  } catch (e) {
    if (e instanceof CryptoUnsupportedError) throw e
    throw new CryptoAuthError()
  }
}

// ---------- additional authenticated data ----------

export const FORMAT_VERSION = 1
/** Version of the record payload schema. Bound into every record's AAD. */
export const RECORD_SCHEMA_VERSION = 1

/** Binds a ciphertext to its record id, type and schema version: moving it to another record/type fails authentication. */
export const recordAad = (type: string, id: string, schemaVersion: number): Bytes => encodeText(`spendflow-record|f${FORMAT_VERSION}|${type}|${id}|s${schemaVersion}`)
export const metaCheckAad = (iterations: number, saltB64: string): Bytes => encodeText(`spendflow-vault-check|f${FORMAT_VERSION}|${iterations}|${saltB64}`)
export const backupAad = (createdAt: string, appSchemaVersion: number, iterations: number, saltB64: string): Bytes =>
  encodeText(`spendflow-backup|f${FORMAT_VERSION}|${createdAt}|s${appSchemaVersion}|${iterations}|${saltB64}`)
