/**
 * Encrypted vault store.
 *
 *  - Persistence: Dexie/IndexedDB database `spendflow-vault` with two tables, `meta` (KDF params + key check) and
 *    `records` (AES-GCM ciphertext rows). No financial field is stored or indexed in clear.
 *  - Session: while unlocked, decrypted records live ONLY in an in-memory cache and the (non-extractable) CryptoKey
 *    lives in a private field. Locking drops both references. JavaScript cannot guarantee that every copy is erased
 *    from memory (GC, engine internals, DevTools heap snapshots) - locking removes the application's access to the
 *    data, it does not forensically wipe RAM.
 *  - Writes: all mutations go through `write()`: serialised, encrypted FIRST, then applied in ONE IndexedDB
 *    transaction, then to the memory cache. A failure at any step leaves both storage and cache unchanged.
 */
import Dexie, { type Table } from 'dexie'
import { defaultSettings, seedCategories } from '@/db/defaults'
import {
  assertKdfAcceptable, calibrateIterations, CryptoAuthError, decodeText, decrypt, deriveKey, encodeText, encrypt, FORMAT_VERSION, metaCheckAad,
  newKdfParams, NonceGuard, RECORD_SCHEMA_VERSION, recordAad, toB64, type KdfParams,
} from './crypto'
import { CHECK_PLAINTEXT, rowKey, TABLES, vaultMetaSchema, type TableMap, type TableName, type Tables, type VaultMeta, type VaultRow } from './format'
import { assessPassword, MIN_PASSWORD_LENGTH } from './password'

export type VaultStatus = 'unknown' | 'uninitialized' | 'locked' | 'unlocked'

export class VaultLockedError extends Error {
  constructor() {
    super('The vault is locked')
  }
}
/** Generic on purpose: never says whether the password, the data or the parameters were wrong. */
export class VaultAuthError extends Error {
  retryAfterMs?: number
  constructor(retryAfterMs?: number) {
    super('Incorrect password, or the vault could not be unlocked.')
    this.retryAfterMs = retryAfterMs
  }
}
export class VaultError extends Error {}

class VaultDB extends Dexie {
  meta!: Table<VaultMeta, string>
  records!: Table<VaultRow, string>
  constructor(name: string) {
    super(name)
    // No indexes on financial data: only the primary key and the (non-sensitive) table name.
    this.version(1).stores({ meta: 'id', records: 'key, type' })
  }
}

type Cache = { [K in TableName]: Map<string, TableMap[K]> }
interface Session {
  key: CryptoKey
  guard: NonceGuard
  cache: Cache
}
type Op = { kind: 'put'; table: TableName; rec: { id: string } } | { kind: 'delete'; table: TableName; id: string }

export interface Reader {
  get<K extends TableName>(t: K, id: string): TableMap[K] | undefined
  all<K extends TableName>(t: K): TableMap[K][]
  filter<K extends TableName>(t: K, fn: (r: TableMap[K]) => boolean): TableMap[K][]
}
export interface Writer extends Reader {
  put<K extends TableName>(t: K, rec: TableMap[K]): void
  delete(t: TableName, id: string): void
}

export interface InitOptions {
  /** PBKDF2 iterations. Defaults to a per-device calibrated value (>= policy floor). */
  iterations?: number
  /** records to place in the new vault (e.g. migrated legacy data). Missing settings/categories are seeded. */
  initial?: Partial<Tables>
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v)
  }
  return o
}

const emptyCache = (): Cache => ({ accounts: new Map(), transactions: new Map(), categories: new Map(), budgets: new Map(), loans: new Map(), loanPayments: new Map(), goals: new Map(), settings: new Map() })

function buildCache(t: Partial<Tables>): Cache {
  const c = emptyCache()
  for (const name of TABLES) for (const r of (t[name] ?? []) as { id: string }[]) (c[name] as Map<string, unknown>).set(r.id, deepFreeze(r))
  return c
}

export class VaultStore {
  private db: VaultDB
  private session: Session | null = null
  private status: VaultStatus = 'unknown'
  private version = 0
  private listeners = new Set<() => void>()
  private chain: Promise<unknown> = Promise.resolve()
  private failures = 0
  private blockedUntil = 0
  private snap: { version: number; data: Tables } | null = null
  /** records skipped at unlock because they failed authentication (corruption/tampering) */
  integrityIssues = 0

  constructor(dbName: string) {
    this.db = new VaultDB(dbName)
  }

  // ----- subscription (React useSyncExternalStore) -----
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  getVersion = (): number => this.version
  getStatus = (): VaultStatus => this.status
  isUnlocked = (): boolean => this.session !== null
  private notify(): void {
    this.version++
    this.snap = null
    this.listeners.forEach((l) => l())
  }

  /** Serialises operations so read-modify-write sequences and lock/unlock never interleave. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  /** Determine whether a vault exists. Safe to call repeatedly. */
  async init(): Promise<VaultStatus> {
    return this.exclusive(async () => {
      if (this.session) return this.status
      const meta = await this.db.meta.get('vault')
      this.status = meta ? 'locked' : 'uninitialized'
      this.notify()
      return this.status
    })
  }

  // ----- reads (memory only) -----
  private requireSession(): Session {
    if (!this.session) throw new VaultLockedError()
    return this.session
  }
  get<K extends TableName>(t: K, id: string): TableMap[K] | undefined {
    return this.requireSession().cache[t].get(id) as TableMap[K] | undefined
  }
  all<K extends TableName>(t: K): TableMap[K][] {
    return [...this.requireSession().cache[t].values()] as TableMap[K][]
  }
  /** List + search: records are decrypted in memory, so any predicate works. */
  filter<K extends TableName>(t: K, fn: (r: TableMap[K]) => boolean): TableMap[K][] {
    return this.all(t).filter(fn)
  }
  count(t: TableName): number {
    return this.requireSession().cache[t].size
  }
  /** Stable snapshot of every table for UI rendering (cached per version). */
  snapshot(): Tables {
    this.requireSession()
    if (this.snap && this.snap.version === this.version) return this.snap.data
    const data = Object.fromEntries(TABLES.map((t) => [t, this.all(t)])) as unknown as Tables
    this.snap = { version: this.version, data }
    return data
  }

  // ----- encryption helpers -----
  private async encryptRecord(s: Pick<Session, 'key' | 'guard'>, type: TableName, rec: { id: string }): Promise<VaultRow> {
    const { iv, ct } = await encrypt(s.key, encodeText(JSON.stringify(rec)), recordAad(type, rec.id, RECORD_SCHEMA_VERSION), s.guard)
    return { key: rowKey(type, rec.id), type, v: RECORD_SCHEMA_VERSION, iv, ct }
  }
  private async encryptAll(s: Pick<Session, 'key' | 'guard'>, tables: Partial<Tables>): Promise<VaultRow[]> {
    const jobs: Promise<VaultRow>[] = []
    for (const t of TABLES) for (const r of (tables[t] ?? []) as { id: string }[]) jobs.push(this.encryptRecord(s, t, r))
    return Promise.all(jobs)
  }
  private async decryptRow(key: CryptoKey, row: VaultRow): Promise<{ id: string }> {
    if (row.v > RECORD_SCHEMA_VERSION || !TABLES.includes(row.type) || !row.key.startsWith(`${row.type}:`)) throw new CryptoAuthError()
    const id = row.key.slice(row.type.length + 1)
    const plain = await decrypt(key, row.iv, row.ct, recordAad(row.type, id, row.v))
    const rec = JSON.parse(decodeText(plain)) as { id?: unknown }
    if (!rec || typeof rec !== 'object' || rec.id !== id) throw new CryptoAuthError()
    return rec as { id: string }
  }
  private async buildMeta(key: CryptoKey, kdf: KdfParams, guard: NonceGuard): Promise<VaultMeta> {
    const check = await encrypt(key, encodeText(CHECK_PLAINTEXT), metaCheckAad(kdf.iterations, toB64(kdf.salt)), guard)
    return { id: 'vault', formatVersion: FORMAT_VERSION, createdAt: new Date().toISOString(), cipher: 'AES-256-GCM', kdf, check }
  }
  private async verifyMeta(password: string, meta: VaultMeta): Promise<CryptoKey> {
    assertKdfAcceptable(meta.kdf)
    const key = await deriveKey(password, meta.kdf)
    const plain = await decrypt(key, meta.check.iv, meta.check.ct, metaCheckAad(meta.kdf.iterations, toB64(meta.kdf.salt)))
    if (decodeText(plain) !== CHECK_PLAINTEXT) throw new CryptoAuthError()
    return key
  }

  // ----- lifecycle -----

  /** Creates a brand-new vault protected by `password` and leaves it unlocked. */
  async initialize(password: string, opts: InitOptions = {}): Promise<void> {
    await this.exclusive(async () => {
      if (await this.db.meta.get('vault')) throw new VaultError('A vault already exists')
      if (password.length < MIN_PASSWORD_LENGTH || !assessPassword(password).acceptable) throw new VaultError('Password is too weak')
      const kdf = newKdfParams(opts.iterations ?? (await calibrateIterations()))
      const key = await deriveKey(password, kdf)
      const s = { key, guard: new NonceGuard() }
      const now = new Date().toISOString()
      const tables: Partial<Tables> = { ...opts.initial }
      if (!tables.settings?.length) tables.settings = [defaultSettings()]
      if (!tables.categories?.length) tables.categories = seedCategories(now)
      const rows = await this.encryptAll(s, tables)
      const meta = await this.buildMeta(key, kdf, s.guard)
      await this.db.transaction('rw', this.db.meta, this.db.records, async () => {
        await this.db.records.clear()
        await this.db.records.bulkPut(rows)
        await this.db.meta.put(meta)
      })
      this.session = { ...s, cache: buildCache(tables) }
      this.status = 'unlocked'
      this.integrityIssues = 0
      this.notify()
    })
  }

  /** Verifies the password, decrypts every record into memory. Failure leaves the vault locked. */
  async unlock(password: string): Promise<void> {
    await this.exclusive(async () => {
      if (this.session) return
      const now = Date.now()
      if (now < this.blockedUntil) throw new VaultAuthError(this.blockedUntil - now)
      try {
        const raw = await this.db.meta.get('vault')
        const parsed = vaultMetaSchema.safeParse(raw)
        if (!parsed.success) throw new CryptoAuthError()
        const meta = parsed.data as VaultMeta
        const key = await this.verifyMeta(password, meta)
        const rows = await this.db.records.toArray()
        const tables: Partial<Tables> = {}
        let issues = 0
        for (let i = 0; i < rows.length; i += 250) {
          const out = await Promise.allSettled(rows.slice(i, i + 250).map((r) => this.decryptRow(key, r)))
          out.forEach((res, j) => {
            const row = rows[i + j]!
            if (res.status === 'fulfilled') (tables[row.type] ??= [] as never[]).push(res.value as never)
            else issues++
          })
        }
        this.session = { key, guard: new NonceGuard(), cache: buildCache(tables) }
        this.integrityIssues = issues
        this.failures = 0
        this.status = 'unlocked'
        this.notify()
      } catch {
        this.failures++
        // Cosmetic client-side throttle (it cannot stop an offline attacker; PBKDF2 cost does that).
        if (this.failures >= 5) this.blockedUntil = Date.now() + Math.min(1000 * 2 ** (this.failures - 5), 60_000)
        throw new VaultAuthError(this.blockedUntil > Date.now() ? this.blockedUntil - Date.now() : undefined)
      }
    })
  }

  /** Waits for in-flight writes to finish (no half-written state), then drops the key and decrypted data. */
  async lock(): Promise<void> {
    await this.exclusive(async () => {
      if (!this.session) return
      this.session = null
      this.snap = null
      this.status = 'locked'
      this.notify()
    })
  }

  // ----- writes -----

  /**
   * Runs `fn` with exclusive access. Reads see committed state; put/delete are staged and committed atomically
   * (encrypt all -> one IndexedDB transaction -> update memory). If `fn` throws, nothing is committed.
   */
  async write<T>(fn: (w: Writer) => Promise<T> | T): Promise<T> {
    return this.exclusive(async () => {
      const s = this.requireSession()
      const ops: Op[] = []
      const reader: Reader = {
        get: (t, id) => s.cache[t].get(id) as never,
        all: (t) => [...s.cache[t].values()] as never,
        filter: (t, f) => ([...s.cache[t].values()] as never[]).filter(f),
      }
      const w: Writer = {
        ...reader,
        put: (t, rec) => void ops.push({ kind: 'put', table: t, rec }),
        delete: (t, id) => void ops.push({ kind: 'delete', table: t, id }),
      }
      const result = await fn(w)
      await this.commit(s, ops)
      return result
    })
  }

  private async commit(s: Session, ops: Op[]): Promise<void> {
    if (ops.length === 0) return
    // 1. encrypt (may throw: nothing has been touched yet)
    const puts = new Map<string, VaultRow>()
    const deletes = new Set<string>()
    for (const op of ops) {
      if (op.kind === 'put') {
        const row = await this.encryptRecord(s, op.table, op.rec)
        puts.set(row.key, row)
        deletes.delete(row.key)
      } else {
        const k = rowKey(op.table, op.id)
        deletes.add(k)
        puts.delete(k)
      }
    }
    // 2. one atomic IndexedDB transaction
    await this.db.transaction('rw', this.db.records, async () => {
      if (puts.size) await this.db.records.bulkPut([...puts.values()])
      if (deletes.size) await this.db.records.bulkDelete([...deletes])
    })
    // 3. only now update memory
    for (const op of ops) {
      if (op.kind === 'put') (s.cache[op.table] as Map<string, unknown>).set(op.rec.id, deepFreeze(op.rec))
      else s.cache[op.table].delete(op.id)
    }
    this.notify()
  }

  /**
   * Replaces EVERYTHING with `tables` (restore/replace). Staged: all rows are encrypted before any storage change,
   * then storage is swapped in one transaction. If anything fails, the existing vault is untouched.
   */
  async replaceAll(tables: Partial<Tables>): Promise<void> {
    await this.exclusive(async () => {
      const s = this.requireSession()
      const next: Partial<Tables> = { ...tables }
      const now = new Date().toISOString()
      if (!next.settings?.length) next.settings = [defaultSettings()]
      if (!next.categories?.length) next.categories = seedCategories(now)
      const rows = await this.encryptAll(s, next)
      await this.db.transaction('rw', this.db.records, async () => {
        await this.db.records.clear()
        await this.db.records.bulkPut(rows)
      })
      s.cache = buildCache(next)
      this.notify()
    })
  }

  /**
   * Re-encrypts the whole vault under a new password (new salt, new key). The OLD password is required and
   * verified, every record is authenticated with the old key first, and storage is swapped in ONE transaction.
   * On any failure the old password and data remain valid.
   */
  async changePassword(oldPassword: string, newPassword: string, opts: { iterations?: number } = {}): Promise<void> {
    await this.exclusive(async () => {
      const s = this.requireSession()
      if (newPassword.length < MIN_PASSWORD_LENGTH || !assessPassword(newPassword).acceptable) throw new VaultError('Password is too weak')
      const parsed = vaultMetaSchema.safeParse(await this.db.meta.get('vault'))
      if (!parsed.success) throw new VaultAuthError()
      let oldKey: CryptoKey
      try {
        oldKey = await this.verifyMeta(oldPassword, parsed.data as VaultMeta)
      } catch {
        throw new VaultAuthError()
      }
      // authenticate + decrypt EVERYTHING from storage with the old key; refuse to proceed if anything fails
      const rows = await this.db.records.toArray()
      const plain: Partial<Tables> = {}
      try {
        for (const r of rows) (plain[r.type] ??= [] as never[]).push((await this.decryptRow(oldKey, r)) as never)
      } catch {
        throw new VaultError('Some stored records could not be verified, so the password was not changed.')
      }
      const kdf = newKdfParams(opts.iterations ?? (await calibrateIterations()))
      const newKey = await deriveKey(newPassword, kdf)
      const guard = new NonceGuard()
      const newRows = await this.encryptAll({ key: newKey, guard }, plain)
      const meta = await this.buildMeta(newKey, kdf, guard)
      await this.db.transaction('rw', this.db.meta, this.db.records, async () => {
        await this.db.records.clear()
        await this.db.records.bulkPut(newRows)
        await this.db.meta.put(meta)
      })
      this.session = { key: newKey, guard, cache: s.cache }
      this.notify()
    })
  }

  /** Deletes the entire vault (all records, KDF parameters, key check). Irreversible. */
  async destroy(): Promise<void> {
    await this.exclusive(async () => {
      await this.db.transaction('rw', this.db.meta, this.db.records, async () => {
        await this.db.records.clear()
        await this.db.meta.clear()
      })
      this.session = null
      this.snap = null
      this.status = 'uninitialized'
      this.failures = 0
      this.blockedUntil = 0
      this.notify()
    })
  }

  /** Technical facts that remain visible in IndexedDB without the password (documented in docs/SECURITY.md). */
  async visibleMetadata(): Promise<{ rows: number; byTable: Record<string, number>; ciphertextBytes: number }> {
    const rows = await this.db.records.toArray()
    const byTable: Record<string, number> = {}
    let ciphertextBytes = 0
    for (const r of rows) {
      byTable[r.type] = (byTable[r.type] ?? 0) + 1
      ciphertextBytes += r.ct.length
    }
    return { rows: rows.length, byTable, ciphertextBytes }
  }

  /** Test/diagnostic access to raw persisted rows. Never used by application code. */
  async _rawRows(): Promise<{ meta: VaultMeta | undefined; rows: VaultRow[] }> {
    return { meta: await this.db.meta.get('vault'), rows: await this.db.records.toArray() }
  }
  _rawDb(): VaultDB {
    return this.db
  }
}

export const vault = new VaultStore('spendflow-vault')
