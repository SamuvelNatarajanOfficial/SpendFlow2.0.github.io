/**
 * Password-protected backup file (JSON envelope). Independent of the live vault: it has its OWN random salt,
 * KDF parameters and nonce, so the backup password may differ from the vault password and no vault key or nonce is
 * ever reused.
 *
 *  {
 *    format: "spendflow-encrypted-backup", formatVersion: 1,
 *    createdAt, appSchemaVersion, cipher: "AES-256-GCM",
 *    kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt(b64) },
 *    iv(b64), ciphertext(b64)           // ciphertext || tag
 *  }
 *
 * The header is not secret but IS authenticated: it is bound into the GCM additional data, so changing the
 * version, date, iteration count or salt makes decryption fail. Record counts and everything financial are inside
 * the ciphertext only.
 */
import { BACKUP_SCHEMA_VERSION } from '@/db/schemas'
import {
  assertKdfAcceptable, backupAad, calibrateIterations, decodeText, decrypt, deriveKey, encodeText, encrypt, fromB64, newKdfParams, NonceGuard, toB64,
  CryptoAuthError,
} from './crypto'
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, envelopeSchema, type BackupEnvelope } from './format'

export const MAX_BACKUP_BYTES = 25 * 1024 * 1024

export type InspectResult =
  | { ok: true; kind: 'encrypted'; header: BackupEnvelope }
  | { ok: true; kind: 'legacy-plain' }
  | { ok: false; code: 'too-large' | 'not-json' | 'not-backup' | 'unsupported-version' | 'malformed'; message: string }

/** Reads ONLY the public header. Reveals no financial data and needs no password. */
export function inspectBackup(text: string): InspectResult {
  if (text.length > MAX_BACKUP_BYTES) return { ok: false, code: 'too-large', message: 'The file is larger than 25 MB.' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, code: 'not-json', message: 'This file is not valid JSON, so it is not a SpendFlow backup.' }
  }
  if (!raw || typeof raw !== 'object') return { ok: false, code: 'not-backup', message: 'This is not a SpendFlow backup file.' }
  const o = raw as Record<string, unknown>
  if (o.app === 'spendflow' && o.format === undefined) return { ok: true, kind: 'legacy-plain' }
  if (o.format !== BACKUP_FORMAT) return { ok: false, code: 'not-backup', message: 'This is not a SpendFlow backup file.' }
  if (o.formatVersion !== BACKUP_FORMAT_VERSION) {
    return { ok: false, code: 'unsupported-version', message: `This backup uses format version ${String(o.formatVersion)}, which this version of SpendFlow cannot read. Update the app and try again.` }
  }
  const parsed = envelopeSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, code: 'malformed', message: 'The backup file is damaged or incomplete.' }
  const h = parsed.data
  try {
    const salt = fromB64(h.kdf.salt)
    assertKdfAcceptable({ iterations: h.kdf.iterations, salt })
    if (fromB64(h.iv).length !== 12) throw new Error('iv')
    fromB64(h.ciphertext)
    if (isNaN(Date.parse(h.createdAt))) throw new Error('date')
  } catch {
    return { ok: false, code: 'malformed', message: 'The backup file is damaged or has invalid encryption parameters.' }
  }
  return { ok: true, kind: 'encrypted', header: h }
}

/** Encrypts a serialised backup payload with a fresh salt and nonce. */
export async function encryptBackup(payloadJson: string, password: string, opts: { iterations?: number } = {}): Promise<string> {
  const kdf = newKdfParams(opts.iterations ?? (await calibrateIterations()))
  const key = await deriveKey(password, kdf)
  const createdAt = new Date().toISOString()
  const saltB64 = toB64(kdf.salt)
  const { iv, ct } = await encrypt(key, encodeText(payloadJson), backupAad(createdAt, BACKUP_SCHEMA_VERSION, kdf.iterations, saltB64), new NonceGuard())
  const envelope: BackupEnvelope = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt,
    appSchemaVersion: BACKUP_SCHEMA_VERSION,
    cipher: 'AES-256-GCM',
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: kdf.iterations, salt: saltB64 },
    iv: toB64(iv),
    ciphertext: toB64(ct),
  }
  return JSON.stringify(envelope)
}

export type DecryptResult = { ok: true; payloadJson: string } | { ok: false; code: 'auth' | 'malformed'; message: string }

/**
 * Verifies the authentication tag and decrypts. AES-GCM cannot tell a wrong password from a modified file, so
 * both produce the same message.
 */
export async function decryptBackup(header: BackupEnvelope, password: string): Promise<DecryptResult> {
  try {
    const salt = fromB64(header.kdf.salt)
    const key = await deriveKey(password, { name: 'PBKDF2', hash: 'SHA-256', iterations: header.kdf.iterations, salt })
    const aad = backupAad(header.createdAt, header.appSchemaVersion, header.kdf.iterations, header.kdf.salt)
    const plain = await decrypt(key, fromB64(header.iv), fromB64(header.ciphertext), aad)
    return { ok: true, payloadJson: decodeText(plain) }
  } catch (e) {
    if (e instanceof CryptoAuthError) return { ok: false, code: 'auth', message: 'Could not decrypt the backup. The password is wrong, or the file was modified or corrupted.' }
    return { ok: false, code: 'malformed', message: 'The backup file could not be read.' }
  }
}
