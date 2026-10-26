import Dexie from 'dexie'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { vault, VaultAuthError, VaultError, VaultLockedError } from './store'
import {
  chooseIterations, CryptoAuthError, CryptoUnsupportedError, cryptoSupport, decrypt, deriveKey, encrypt, kdfPolicy, newKdfParams, NonceGuard, PRODUCTION_KDF_POLICY,
  randomBytes, recordAad, toB64, fromB64, calibrateIterations, backupAad,
} from './crypto'
import { assessPassword, MIN_PASSWORD_LENGTH } from './password'
import { detectLegacy, setupVault } from './legacy'
import { accounts, loans, transactions, getSettings } from '@/db/repo'
import { builtInCategoryId } from '@/db/defaults'

const PW = 'correct horse battery staple 42!'
const PW2 = 'a completely different passphrase 99?'
const fast = { iterations: 1000 }
const food = builtInCategoryId('expense', 'Groceries')

async function fresh() {
  await vault.destroy()
  await vault.initialize(PW, fast)
}
async function addTx(merchant = 'Mart', amount = 25050) {
  const a = vault.all('accounts')[0] ?? (await accounts.create({ name: 'Bank', type: 'savings', openingBalance: 100000 }))
  return transactions.create({ type: 'expense', amount, date: '2025-03-02', accountId: a.id, categoryId: food, paymentMethod: 'upi', merchant, notes: 'secret note' })
}
/** Reads the persisted IndexedDB database directly, bypassing the application, as an attacker with disk access would. */
async function rawDump(): Promise<{ text: string; stores: Record<string, { keyPath: unknown; indexes: string[] }>; rows: { key: string; type: string; v: number; iv: Uint8Array; ct: Uint8Array }[] }> {
  const db = await new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open('spendflow-vault')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
  const names = [...db.objectStoreNames]
  const stores: Record<string, { keyPath: unknown; indexes: string[] }> = {}
  const dump: Record<string, unknown[]> = {}
  for (const n of names) {
    const tx = db.transaction(n, 'readonly')
    const st = tx.objectStore(n)
    stores[n] = { keyPath: st.keyPath, indexes: [...st.indexNames] }
    dump[n] = await new Promise<unknown[]>((res, rej) => {
      const q = st.getAll()
      q.onsuccess = () => res(q.result)
      q.onerror = () => rej(q.error)
    })
  }
  db.close()
  // flatten everything (strings + raw bytes as latin1 and as hex) into one searchable blob
  const parts: string[] = []
  const walk = (v: unknown) => {
    if (v instanceof Uint8Array) parts.push(String.fromCharCode(...v), Buffer.from(v).toString('hex'), Buffer.from(v).toString('utf8'))
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => (parts.push(k), walk(x)))
    else parts.push(String(v))
  }
  walk(dump)
  return { text: parts.join('\n'), stores, rows: dump.records as never }
}

beforeEach(fresh)

describe('crypto primitives', () => {
  it('uses the documented production KDF policy (OWASP floor) and refuses weaker creation', () => {
    expect(PRODUCTION_KDF_POLICY.minIterations).toBeGreaterThanOrEqual(600_000)
    expect(PRODUCTION_KDF_POLICY.maxIterations).toBeGreaterThan(PRODUCTION_KDF_POLICY.minIterations)
    expect(() => newKdfParams(kdfPolicy.minIterations - 1)).toThrow(/at least/)
    expect(newKdfParams(kdfPolicy.minIterations).salt).toHaveLength(16)
  })
  it('chooses iterations from device speed, clamped to policy', () => {
    const P = PRODUCTION_KDF_POLICY
    expect(chooseIterations(10_000, P)).toBe(P.minIterations) // very slow device: floor, never lower
    expect(chooseIterations(0.001, P)).toBe(P.maxIterations) // very fast: capped so phones are not locked out
    const mid = chooseIterations(25, P) // 25 ms per 100k => 750ms target = 3,000,000 -> capped
    expect(mid).toBeLessThanOrEqual(P.maxIterations)
    expect(chooseIterations(100, P)).toBe(750_000)
    expect(chooseIterations(NaN, P)).toBe(P.minIterations)
  })
  it('calibration returns a value within policy', async () => {
    const n = await calibrateIterations()
    expect(n).toBeGreaterThanOrEqual(kdfPolicy.minIterations)
    expect(n).toBeLessThanOrEqual(kdfPolicy.maxIterations)
  })
  it('round-trips and binds ciphertext to record id, type and schema version (AAD)', async () => {
    const key = await deriveKey(PW, newKdfParams(1000))
    const g = new NonceGuard()
    const msg = new TextEncoder().encode('{"amount":123456}')
    const { iv, ct } = await encrypt(key, msg, recordAad('transactions', 'id-1', 1), g)
    expect(new TextDecoder().decode(await decrypt(key, iv, ct, recordAad('transactions', 'id-1', 1)))).toBe('{"amount":123456}')
    for (const bad of [recordAad('transactions', 'id-2', 1), recordAad('accounts', 'id-1', 1), recordAad('transactions', 'id-1', 2)]) {
      await expect(decrypt(key, iv, ct, bad)).rejects.toBeInstanceOf(CryptoAuthError)
    }
    const flipped = ct.slice()
    flipped[0]! ^= 1
    await expect(decrypt(key, iv, flipped, recordAad('transactions', 'id-1', 1))).rejects.toBeInstanceOf(CryptoAuthError)
    const truncated = ct.slice(0, ct.length - 1)
    await expect(decrypt(key, iv, truncated, recordAad('transactions', 'id-1', 1))).rejects.toBeInstanceOf(CryptoAuthError)
    const otherKey = await deriveKey(PW2, newKdfParams(1000))
    await expect(decrypt(otherKey, iv, ct, recordAad('transactions', 'id-1', 1))).rejects.toBeInstanceOf(CryptoAuthError)
  })
  it('derived keys are non-extractable', async () => {
    const key = await deriveKey(PW, newKdfParams(1000))
    expect(key.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow()
  })
  it('generates unique random salts and nonces', async () => {
    const salts = new Set(Array.from({ length: 200 }, () => toB64(newKdfParams(1000).salt)))
    expect(salts.size).toBe(200)
    const g = new NonceGuard()
    const nonces = new Set(Array.from({ length: 5000 }, () => toB64(g.next())))
    expect(nonces.size).toBe(5000)
    expect(g.next()).toHaveLength(12)
    expect(randomBytes(32)).toHaveLength(32)
  })
  it('nonce guard rejects a repeat even if the RNG misbehaves (mocked RNG, test only)', () => {
    const g = new NonceGuard()
    const first = g.next()
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((arr: Uint8Array) => {
      arr.set(first)
      return arr
    }) as never)
    expect(() => g.next()).toThrow(/Random number generator failure/)
    spy.mockRestore()
    expect(g.next()).toHaveLength(12)
  })
  it('base64 helpers reject malformed input', () => {
    expect(fromB64(toB64(new Uint8Array([1, 2, 3, 250])))).toEqual(new Uint8Array([1, 2, 3, 250]))
    expect(() => fromB64('!!!!')).toThrow()
    expect(() => fromB64('abc')).toThrow()
  })
  it('fails safely when Web Crypto is unavailable (no insecure fallback)', async () => {
    vi.stubGlobal('crypto', {})
    try {
      expect(cryptoSupport().ok).toBe(false)
      expect(() => randomBytes(8)).toThrow(CryptoUnsupportedError)
      await expect(deriveKey(PW, { name: 'PBKDF2', hash: 'SHA-256', iterations: 1000, salt: new Uint8Array(16) })).rejects.toBeInstanceOf(CryptoUnsupportedError)
    } finally {
      vi.unstubAllGlobals()
    }
    vi.stubGlobal('isSecureContext', false)
    try {
      expect(cryptoSupport()).toMatchObject({ ok: false, reason: expect.stringMatching(/secure context/) })
    } finally {
      vi.unstubAllGlobals()
    }
    expect(cryptoSupport().ok).toBe(true)
  })
  it('backup AAD changes with every header field', () => {
    const base = backupAad('2025-01-01T00:00:00.000Z', 1, 600000, 'c2FsdA==')
    expect(backupAad('2025-01-02T00:00:00.000Z', 1, 600000, 'c2FsdA==')).not.toEqual(base)
    expect(backupAad('2025-01-01T00:00:00.000Z', 2, 600000, 'c2FsdA==')).not.toEqual(base)
    expect(backupAad('2025-01-01T00:00:00.000Z', 1, 600001, 'c2FsdA==')).not.toEqual(base)
    expect(backupAad('2025-01-01T00:00:00.000Z', 1, 600000, 'c2FsdB==')).not.toEqual(base)
  })
})

describe('password policy', () => {
  it('rejects short, common, sequential and repetitive passwords; accepts passphrases', () => {
    expect(assessPassword('short1!').acceptable).toBe(false)
    expect(assessPassword('password1234').acceptable).toBe(false)
    expect(assessPassword('123456789012').acceptable).toBe(false)
    expect(assessPassword('aaaaaaaaaaaaaaaa').acceptable).toBe(false)
    expect(assessPassword('abcdefghijklmnop').acceptable).toBe(false)
    expect(assessPassword('qwertyuiopasdfgh').acceptable).toBe(false)
    expect(assessPassword('9876543210zyxwvu').acceptable).toBe(false)
    expect(assessPassword('Tr0ub4dor&3-horse-staple').acceptable).toBe(true)
    expect(assessPassword(PW).acceptable).toBe(true)
    expect(assessPassword('tiger-lamp-orbit-river').acceptable).toBe(true)
    expect(assessPassword('x'.repeat(MIN_PASSWORD_LENGTH - 1) + '9').hints.length).toBeGreaterThan(0)
  })
  it('the vault itself refuses weak passwords', async () => {
    await vault.destroy()
    await expect(vault.initialize('password1234', fast)).rejects.toThrow(VaultError)
    await expect(vault.initialize('short', fast)).rejects.toThrow(VaultError)
    expect(vault.getStatus()).toBe('uninitialized')
  })
})

describe('unlock / lock', () => {
  it('correct password unlocks and restores records; incorrect password fails generically', async () => {
    const t = await addTx()
    await vault.lock()
    expect(vault.getStatus()).toBe('locked')
    await expect(vault.unlock('wrong password entirely 1!')).rejects.toBeInstanceOf(VaultAuthError)
    expect(vault.isUnlocked()).toBe(false)
    await vault.unlock(PW)
    expect(vault.isUnlocked()).toBe(true)
    expect(vault.get('transactions', t.id)?.merchant).toBe('Mart')
    expect(vault.integrityIssues).toBe(0)
  })
  it('failure messages never reveal which part was wrong', async () => {
    await vault.lock()
    const msgs = new Set<string>()
    for (const p of ['wrong password entirely 1!', '', PW + ' ']) {
      try {
        await vault.unlock(p)
      } catch (e) {
        msgs.add((e as Error).message)
      }
    }
    expect([...msgs]).toEqual(['Incorrect password, or the vault could not be unlocked.'])
  })
  it('passwords are NFKC-normalised so equivalent Unicode forms unlock the same vault', async () => {
    await vault.destroy()
    const composed = 'café au lait with sugar 77!'
    await vault.initialize(composed, fast)
    await vault.lock()
    await vault.unlock('café au lait with sugar 77!') // decomposed é
    expect(vault.isUnlocked()).toBe(true)
  })
  it('throttles repeated failures (cosmetic client-side backoff)', async () => {
    await vault.lock()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      for (let i = 0; i < 5; i++) await expect(vault.unlock('nope nope nope nope 1!')).rejects.toBeInstanceOf(VaultAuthError)
      const blocked = await vault.unlock(PW).catch((e) => e)
      expect(blocked).toBeInstanceOf(VaultAuthError)
      expect((blocked as VaultAuthError).retryAfterMs).toBeGreaterThan(0)
      vi.advanceTimersByTime(61_000)
      await vault.unlock(PW)
      expect(vault.isUnlocked()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
  it('locking removes access to decrypted data through every application API', async () => {
    const t = await addTx()
    await vault.lock()
    expect(() => vault.all('transactions')).toThrow(VaultLockedError)
    expect(() => vault.get('transactions', t.id)).toThrow(VaultLockedError)
    expect(() => vault.filter('transactions', () => true)).toThrow(VaultLockedError)
    expect(() => vault.snapshot()).toThrow(VaultLockedError)
    expect(() => vault.count('accounts')).toThrow(VaultLockedError)
    await expect(vault.write(() => 1)).rejects.toBeInstanceOf(VaultLockedError)
    await expect(transactions.create({ type: 'expense', amount: 1, date: '2025-03-02', accountId: t.accountId, paymentMethod: 'upi' })).rejects.toBeInstanceOf(VaultLockedError)
    await expect(getSettings()).rejects.toBeInstanceOf(VaultLockedError)
    await expect(vault.replaceAll({})).rejects.toBeInstanceOf(VaultLockedError)
    await expect(vault.changePassword(PW, PW2, fast)).rejects.toBeInstanceOf(VaultLockedError)
  })
  it('lock waits for an in-flight write, so nothing is half-saved', async () => {
    const a = await accounts.create({ name: 'Bank', type: 'savings', openingBalance: 0 })
    const slow = transactions.create({ type: 'expense', amount: 500, date: '2025-03-02', accountId: a.id, paymentMethod: 'upi', merchant: 'inflight' })
    const lock = vault.lock() // issued while the write is still pending
    await slow
    await lock
    expect(vault.isUnlocked()).toBe(false)
    await vault.unlock(PW)
    expect(vault.filter('transactions', (t) => t.merchant === 'inflight')).toHaveLength(1)
  })
  it('a corrupted/tampered unlock parameter set cannot cause a denial of service', async () => {
    await vault.lock()
    const raw = vault._rawDb()
    const meta = (await raw.meta.get('vault'))!
    await raw.meta.put({ ...meta, kdf: { ...meta.kdf, iterations: 2_000_000_000 } })
    const t0 = Date.now()
    await expect(vault.unlock(PW)).rejects.toBeInstanceOf(VaultAuthError)
    expect(Date.now() - t0).toBeLessThan(2000)
    await raw.meta.put({ ...meta, kdf: { ...meta.kdf, salt: new Uint8Array(1) } })
    await expect(vault.unlock(PW)).rejects.toBeInstanceOf(VaultAuthError)
    await raw.meta.put({ ...meta, formatVersion: 1, cipher: 'ROT13' } as never)
    await expect(vault.unlock(PW)).rejects.toBeInstanceOf(VaultAuthError)
  })
  it('records are immutable in memory (accidental mutation is impossible)', async () => {
    const t = await addTx()
    const rec = vault.get('transactions', t.id)!
    expect(() => {
      ;(rec as { amount: number }).amount = 1
    }).toThrow()
    expect(vault.get('transactions', t.id)?.amount).toBe(25050)
  })
})

describe('encrypted storage on disk', () => {
  it('persists NO plaintext financial data, and no index on any financial field', async () => {
    const a = await accounts.create({ name: 'ZZ-Account-Name', type: 'savings', openingBalance: 98765432 })
    await transactions.create({ type: 'expense', amount: 1234567, date: '2031-07-19', accountId: a.id, categoryId: food, paymentMethod: 'cheque', merchant: 'ZZ-UNIQUE-MERCHANT', notes: 'ZZ-PRIVATE-NOTE' })
    const loan = await loans.create({ name: 'ZZ-Home-Loan', lender: 'ZZ-Lender-Bank', principal: 77777777, outstanding: 77777777, annualRate: 8.25, emi: 612345, dueDay: 7, startDate: '2024-01-07', tenureMonths: 240, accountId: a.id })
    await loans.recordPayment({ loanId: loan.id, date: '2031-07-20', kind: 'emi', amount: 612345, accountId: a.id })

    const { text, stores, rows } = await rawDump()
    for (const needle of [
      'ZZ-Account-Name', 'ZZ-UNIQUE-MERCHANT', 'ZZ-PRIVATE-NOTE', 'ZZ-Home-Loan', 'ZZ-Lender-Bank', '2031-07-19', '98765432', '1234567', '77777777', '612345', '8.25',
      'Groceries', 'Salary', 'EMI & Loans', 'Asia/Kolkata', 'amount', 'merchant', 'openingBalance', 'principal', 'categoryId', 'accountId', 'upi', 'cheque',
    ]) {
      expect(text, `plaintext "${needle}" leaked into IndexedDB`).not.toContain(needle)
    }
    // the only indexes are the primary key and the non-sensitive table name
    expect(stores.records!.keyPath).toBe('key')
    expect(stores.records!.indexes).toEqual(['type'])
    expect(stores.meta!.indexes).toEqual([])
    // rows carry only technical metadata
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['ct', 'iv', 'key', 'type', 'v'])
    // the legacy plaintext database does not exist
    expect(await Dexie.exists('spendflow')).toBe(false)
  })
  it('exposes only the documented metadata without the password', async () => {
    await addTx()
    const m = await vault.visibleMetadata()
    expect(m.rows).toBeGreaterThan(18)
    expect(Object.keys(m.byTable).sort()).toEqual(['accounts', 'categories', 'settings', 'transactions'])
  })
  it('every record uses a distinct random nonce; rewriting a record uses a NEW nonce', async () => {
    for (let i = 0; i < 60; i++) await addTx(`m${i}`, 100 + i)
    const t = vault.all('transactions')[0]
    const before = (await vault._rawRows()).rows.find((r) => r.key === `transactions:${t!.id}`)!
    await transactions.update(t!.id, { amount: 999 })
    const after = (await vault._rawRows()).rows.find((r) => r.key === `transactions:${t!.id}`)!
    expect(toB64(after.iv)).not.toBe(toB64(before.iv))
    const { rows, meta } = await vault._rawRows()
    const ivs = [...rows.map((r) => toB64(r.iv)), toB64(meta!.check.iv)]
    expect(new Set(ivs).size).toBe(ivs.length)
    expect(rows.every((r) => r.iv.length === 12)).toBe(true)
  })
  it('two vaults get different salts and the same data encrypts to different bytes', async () => {
    await addTx()
    const m1 = (await vault._rawRows()).meta!
    await fresh()
    await addTx()
    const m2 = (await vault._rawRows()).meta!
    expect(toB64(m1.kdf.salt)).not.toBe(toB64(m2.kdf.salt))
    expect(m1.kdf.iterations).toBeGreaterThanOrEqual(1000)
    expect(m2).toMatchObject({ formatVersion: 1, cipher: 'AES-256-GCM', kdf: { name: 'PBKDF2', hash: 'SHA-256' } })
  })
})

describe('tamper detection', () => {
  it('a modified ciphertext fails authentication; the rest of the vault still opens and the problem is reported', async () => {
    const t1 = await addTx('one')
    const t2 = await addTx('two')
    await vault.lock()
    const raw = vault._rawDb()
    const row = (await raw.records.get(`transactions:${t1.id}`))!
    const ct = row.ct.slice()
    ct[3]! ^= 0x01
    await raw.records.put({ ...row, ct })
    await vault.unlock(PW)
    expect(vault.integrityIssues).toBe(1)
    expect(vault.get('transactions', t1.id)).toBeUndefined() // never returns unauthenticated data
    expect(vault.get('transactions', t2.id)?.merchant).toBe('two')
  })
  it('modified nonce, tag truncation or version bump are all rejected', async () => {
    const t = await addTx()
    await vault.lock()
    const raw = vault._rawDb()
    const row = (await raw.records.get(`transactions:${t.id}`))!
    const variants = [
      { ...row, iv: row.iv.map((b, i) => (i === 0 ? b ^ 1 : b)) },
      { ...row, ct: row.ct.slice(0, row.ct.length - 1) },
      { ...row, v: row.v + 1 },
    ]
    for (const v of variants) {
      await raw.records.put(v as never)
      await vault.unlock(PW)
      expect(vault.integrityIssues, 'a tampered row must not be accepted').toBe(1)
      expect(vault.get('transactions', t.id)).toBeUndefined()
      await vault.lock()
    }
  })
  it('swapping ciphertexts between records, or moving one to another table, is detected', async () => {
    const t1 = await addTx('one')
    const t2 = await addTx('two')
    await vault.lock()
    const raw = vault._rawDb()
    const r1 = (await raw.records.get(`transactions:${t1.id}`))!
    const r2 = (await raw.records.get(`transactions:${t2.id}`))!
    await raw.records.put({ ...r2, iv: r1.iv, ct: r1.ct }) // t2's slot now holds t1's ciphertext
    await vault.unlock(PW)
    expect(vault.integrityIssues).toBe(1)
    expect(vault.get('transactions', t2.id)).toBeUndefined()
    await vault.lock()
    await raw.records.put(r2)
    await raw.records.put({ ...r1, key: `goals:${t1.id}`, type: 'goals' }) // same bytes, wrong table
    await vault.unlock(PW)
    expect(vault.integrityIssues).toBe(1)
    expect(vault.all('goals')).toHaveLength(0)
  })
  it('a modified key-check ciphertext makes the vault refuse to unlock', async () => {
    await vault.lock()
    const raw = vault._rawDb()
    const meta = (await raw.meta.get('vault'))!
    const ct = meta.check.ct.slice()
    ct[0]! ^= 1
    await raw.meta.put({ ...meta, check: { ...meta.check, ct } })
    await expect(vault.unlock(PW)).rejects.toBeInstanceOf(VaultAuthError)
    // KDF parameters are bound into the check AAD: changing them is also rejected
    await raw.meta.put({ ...meta, kdf: { ...meta.kdf, iterations: meta.kdf.iterations + 1 } })
    await expect(vault.unlock(PW)).rejects.toBeInstanceOf(VaultAuthError)
    await raw.meta.put(meta)
    await vault.unlock(PW)
    expect(vault.isUnlocked()).toBe(true)
  })
})

describe('atomic writes', () => {
  it('a failing write callback commits nothing', async () => {
    const a = await accounts.create({ name: 'Bank', type: 'savings', openingBalance: 0 })
    const before = (await vault._rawRows()).rows.length
    await expect(
      vault.write((w) => {
        w.put('accounts', { ...a, name: 'Renamed' })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(vault.get('accounts', a.id)?.name).toBe('Bank')
    expect((await vault._rawRows()).rows.length).toBe(before)
  })
  it('a storage failure leaves BOTH storage and memory unchanged', async () => {
    const a = await accounts.create({ name: 'Bank', type: 'savings', openingBalance: 0 })
    const spy = vi.spyOn(vault._rawDb().records, 'bulkPut').mockRejectedValueOnce(new Error('disk full'))
    await expect(accounts.update(a.id, { name: 'Renamed' })).rejects.toThrow('disk full')
    spy.mockRestore()
    expect(vault.get('accounts', a.id)?.name).toBe('Bank')
    await vault.lock()
    await vault.unlock(PW)
    expect(vault.get('accounts', a.id)?.name).toBe('Bank')
  })
  it('concurrent writes are serialised and all persisted with distinct nonces', async () => {
    const a = await accounts.create({ name: 'Bank', type: 'savings', openingBalance: 0 })
    await Promise.all(Array.from({ length: 25 }, (_, i) => transactions.create({ type: 'expense', amount: 100 + i, date: '2025-03-02', accountId: a.id, paymentMethod: 'upi', merchant: `c${i}` })))
    await vault.lock()
    await vault.unlock(PW)
    expect(vault.all('transactions')).toHaveLength(25)
    const ivs = (await vault._rawRows()).rows.map((r) => toB64(r.iv))
    expect(new Set(ivs).size).toBe(ivs.length)
  })
})

describe('password change', () => {
  it('re-encrypts everything: new password works, old password is rejected, nothing is lost', async () => {
    for (let i = 0; i < 10; i++) await addTx(`m${i}`, 1000 + i)
    const loan = await loans.create({ name: 'L', lender: 'B', principal: 100000, outstanding: 100000, annualRate: 10, emi: 9000, dueDay: 5, startDate: '2025-01-05', tenureMonths: 12 })
    await loans.recordPayment({ loanId: loan.id, date: '2025-02-05', kind: 'emi', amount: 9000 })
    const beforeData = JSON.stringify(vault.snapshot())
    const beforeRows = await vault._rawRows()

    await vault.changePassword(PW, PW2, fast)
    expect(vault.isUnlocked()).toBe(true) // stays unlocked, with the new key
    await addTx('after-change')
    const afterRows = await vault._rawRows()
    expect(toB64(afterRows.meta!.kdf.salt)).not.toBe(toB64(beforeRows.meta!.kdf.salt)) // new salt
    const old = new Map(beforeRows.rows.map((r) => [r.key, toB64(r.iv)]))
    for (const r of afterRows.rows) if (old.has(r.key)) expect(toB64(r.iv)).not.toBe(old.get(r.key)) // every record re-encrypted

    await vault.lock()
    await expect(vault.unlock(PW)).rejects.toBeInstanceOf(VaultAuthError) // old password rejected
    await vault.unlock(PW2)
    const after = vault.snapshot()
    expect(after.transactions).toHaveLength(11) // 10 + 'after-change' (the loan payment recorded no account expense)
    expect(vault.integrityIssues).toBe(0)
    // order-independent comparison (IndexedDB returns rows sorted by key); boolean so a failure does not dump data
    const norm = (s: typeof after) => JSON.stringify(Object.entries({ ...s, transactions: s.transactions.filter((t) => t.merchant !== 'after-change') }).map(([k, v]) => [k, [...v].map((r) => JSON.stringify(r)).sort()]).sort())
    expect(norm(after) === norm(JSON.parse(beforeData))).toBe(true)
  })
  it('requires the CURRENT password and a strong, different new password', async () => {
    await expect(vault.changePassword('wrong current password 1!', PW2, fast)).rejects.toBeInstanceOf(VaultAuthError)
    await expect(vault.changePassword(PW, 'weak', fast)).rejects.toBeInstanceOf(VaultError)
    await vault.lock()
    await vault.unlock(PW) // unchanged
    expect(vault.isUnlocked()).toBe(true)
  })
  it('a failure during the swap keeps the old password and data', async () => {
    await addTx('keep')
    const spy = vi.spyOn(vault._rawDb().records, 'bulkPut').mockRejectedValueOnce(new Error('disk full'))
    await expect(vault.changePassword(PW, PW2, fast)).rejects.toThrow('disk full')
    spy.mockRestore()
    await vault.lock()
    await expect(vault.unlock(PW2)).rejects.toBeInstanceOf(VaultAuthError)
    await vault.unlock(PW)
    expect(vault.filter('transactions', (t) => t.merchant === 'keep')).toHaveLength(1)
  })
  it('refuses to change the password if any stored record cannot be verified (never silently drops data)', async () => {
    const t = await addTx()
    const raw = vault._rawDb()
    const row = (await raw.records.get(`transactions:${t.id}`))!
    const ct = row.ct.slice()
    ct[0]! ^= 1
    await raw.records.put({ ...row, ct })
    await expect(vault.changePassword(PW, PW2, fast)).rejects.toThrow(/could not be verified/)
    await vault.lock()
    await vault.unlock(PW) // old password still valid
    expect(vault.isUnlocked()).toBe(true)
  })
})

describe('legacy plaintext migration', () => {
  async function makeLegacy() {
    const l = new Dexie('spendflow')
    l.version(1).stores({
      accounts: 'id, name, type',
      transactions: 'id, date, type, accountId, toAccountId, categoryId, loanPaymentId, [accountId+date]',
      categories: 'id, kind, name',
      budgets: 'id, month, categoryId, &[categoryId+month]',
      loans: 'id',
      loanPayments: 'id, loanId, date',
      goals: 'id',
      settings: 'id',
    })
    const T = '2025-01-01T00:00:00.000Z'
    await l.table('accounts').add({ id: 'acc1', name: 'Old Bank', type: 'savings', openingBalance: 5000, createdAt: T, updatedAt: T })
    await l.table('transactions').add({ id: 'tx1', type: 'expense', amount: 1234, date: '2025-01-05', accountId: 'acc1', paymentMethod: 'upi', merchant: 'OldMerchant', createdAt: T, updatedAt: T })
    await l.table('settings').add({ id: 'app', currency: 'INR', timezone: 'Asia/Kolkata', theme: 'dark', backupReminderDays: 7 })
    l.close()
  }
  it('encrypts existing plaintext data into the vault, verifies it, then deletes the plaintext database', async () => {
    await vault.destroy()
    await makeLegacy()
    expect(await detectLegacy()).toEqual({ records: 2 })
    const r = await setupVault(PW, fast)
    expect(r.migrated).toBe(2)
    expect(vault.get('accounts', 'acc1')?.name).toBe('Old Bank')
    expect(vault.get('transactions', 'tx1')?.merchant).toBe('OldMerchant')
    expect((await getSettings()).theme).toBe('dark') // settings migrated too
    expect(await Dexie.exists('spendflow')).toBe(false)
    expect((await rawDump()).text).not.toContain('OldMerchant')
    await vault.lock()
    await vault.unlock(PW)
    expect(vault.get('transactions', 'tx1')?.amount).toBe(1234)
  })
  it('a failed migration rolls the vault back and leaves the plaintext data untouched', async () => {
    await vault.destroy()
    await makeLegacy()
    const spy = vi.spyOn(vault, 'unlock').mockRejectedValueOnce(new Error('verification read failed'))
    await expect(setupVault(PW, fast)).rejects.toThrow(/original data was kept/)
    spy.mockRestore()
    expect(vault.getStatus()).toBe('uninitialized')
    expect(await Dexie.exists('spendflow')).toBe(true)
    expect(await detectLegacy()).toEqual({ records: 2 }) // still migratable on retry
    await setupVault(PW, fast)
    expect(vault.get('transactions', 'tx1')?.merchant).toBe('OldMerchant')
  })
  it('reports nothing to migrate when there is no legacy data; plain setup works', async () => {
    await vault.destroy()
    expect(await detectLegacy()).toBeNull()
    expect(await setupVault(PW, fast)).toEqual({ migrated: 0 })
    expect(vault.all('categories').length).toBe(18)
  })
})

describe('vault lifecycle', () => {
  it('cannot initialise over an existing vault, and destroy removes everything', async () => {
    await expect(vault.initialize(PW2, fast)).rejects.toThrow(/already exists/)
    await addTx()
    await vault.destroy()
    expect(vault.getStatus()).toBe('uninitialized')
    const { meta, rows } = await vault._rawRows()
    expect(meta).toBeUndefined()
    expect(rows).toHaveLength(0)
    expect(() => vault.all('accounts')).toThrow(VaultLockedError)
  })
  it('init() reports locked for an existing vault in a "new page load"', async () => {
    await vault.lock()
    expect(await vault.init()).toBe('locked')
  })
})
