# SpendFlow security architecture and threat model

This document describes how SpendFlow protects data stored in the browser, what it **does not** protect against, and the evidence (tests) behind each claim. It is written to be read critically: the limitations section matters as much as the design.

## 1. Summary

- SpendFlow is **local-first**: no backend, no accounts, no analytics. Financial data never leaves the browser except in backup files the user chooses to download.
- All financial records are **encrypted before they are written** to IndexedDB with **AES-256-GCM**, using a key derived from the user's password with **PBKDF2-HMAC-SHA-256**. Only the Web Crypto API is used.
- The key exists only in memory while the vault is unlocked. It is never persisted. A page reload, **Lock**, inactivity, or the app being hidden for a while locks the vault.
- Backups are **password-protected encrypted files**. There is no unencrypted JSON export.

**There is no password recovery.** The password is the only thing that can decrypt the data. Keep an encrypted backup and remember its password.

## 2. Architecture

```
 React UI (features/, components/)              <- only ever sees decrypted data from memory
        |
 db/repo.ts (validation + integrity rules)      <- Zod schemas, referential checks, business rules
        |
 vault/store.ts  VaultStore                     <- session, in-memory cache, atomic encrypted writes
        |                    \
 vault/crypto.ts              vault/backupFile.ts   <- Web Crypto primitives / encrypted backup envelope
        |
 IndexedDB "spendflow-vault"  { meta, records }  <- ciphertext + technical metadata only
```

Separation of concerns:

| Module | Responsibility | Depends on |
|---|---|---|
| `vault/crypto.ts` | KDF, AES-GCM, random bytes, AAD builders, KDF policy. No storage, no UI. | Web Crypto |
| `vault/password.ts` | Password strength guidance (heuristic) | nothing |
| `vault/format.ts` | Types + Zod schemas of the persisted vault and backup envelope | zod |
| `vault/store.ts` | Vault lifecycle (initialize, unlock, lock, change password, destroy), decrypted in-memory cache, atomic writes, staged replace | crypto, Dexie |
| `vault/backupFile.ts` | Password-protected backup envelope (encrypt / authenticate / inspect) | crypto |
| `vault/legacy.ts` | One-time migration of the old plaintext database | store, Dexie |
| `db/repo.ts` | Domain operations over the store (validation, cascades) | store |
| `app/VaultGate.tsx`, `AutoLock.tsx` | Setup / unlock screens, inactivity and visibility locking | store |

## 3. Cryptography

| Item | Choice |
|---|---|
| Cipher | AES-256-GCM, 128-bit tag, via `crypto.subtle` |
| KDF | PBKDF2, HMAC-SHA-256, 128-bit random salt per vault and per backup |
| Randomness | `crypto.getRandomValues` only (salts, nonces) |
| Nonce | Fresh random 96-bit value for **every** encryption; an in-session guard additionally rejects any repeat |
| AAD | Binds each ciphertext to context (see below) |
| Key object | Non-extractable `CryptoKey`; raw key bytes are never visible to JavaScript |
| Password handling | NFKC-normalised, UTF-8 encoded, the temporary byte copy is zeroed after import |
| Fallbacks | **None.** If Web Crypto or a secure context is unavailable the app refuses to store data |

### KDF iteration count

`PRODUCTION_KDF_POLICY` (frozen, in `vault/crypto.ts`):

- **Floor: 600,000 iterations**, the OWASP Password Storage Cheat Sheet (2023) figure for PBKDF2-HMAC-SHA-256. Creation below the floor is refused.
- **Calibration:** at vault creation / password change / backup export the app times 100,000 iterations on the device and targets roughly 750 ms, clamped to **[600,000 , 2,500,000]**. Fast devices get a higher cost; slow phones are not locked out.
- The chosen count is stored with the vault/backup, so each file is self-describing and future devices can raise the default without breaking old data.
- **Bounds on untrusted parameters:** when reading a vault or backup, iterations must lie in **[100,000 , 10,000,000]** and the salt must be 16-64 bytes. A tampered file therefore cannot force unbounded work or silently weaken derivation. (Tests lower these numbers; production never does.)

PBKDF2 is not memory-hard. Web Crypto offers no Argon2/scrypt, and we do not ship custom crypto. The practical consequence is that a **strong password matters**: see section 9.

### Nonce discipline

AES-GCM is catastrophically broken by nonce reuse under one key. Each encryption draws 12 fresh random bytes. NIST SP 800-38D permits up to 2^32 random-nonce encryptions per key; a personal ledger performs thousands, so the collision probability is negligible (well below 2^-60 for a million encryptions). The `NonceGuard` also remembers every nonce issued in the current session and rejects repeats (it throws rather than reuse). Every password change creates a new salt and therefore a new key and a fresh nonce space. Rewriting a record always uses a new nonce (tested).

### Authenticated additional data

- **Record:** `spendflow-record|f1|<table>|<record id>|s<record schema version>`
  Moving a ciphertext to another record id, another table, or claiming another schema version fails authentication.
- **Vault key check:** `spendflow-vault-check|f1|<iterations>|<salt b64>`: KDF parameters are bound to the check value.
- **Backup:** `spendflow-backup|f1|<createdAt>|s<app schema>|<iterations>|<salt b64>`: every header field is authenticated.

## 4. Vault format (version 1)

IndexedDB database `spendflow-vault`, two object stores:

`meta` (single row, key `"vault"`):

```
{ id, formatVersion: 1, createdAt, cipher: "AES-256-GCM",
  kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt },
  check: { iv, ct } }            // AES-GCM encryption of a fixed string: wrong password => auth failure
```

`records` (one row per record; primary key `key`, one index on `type`):

```
{ key: "<table>:<random uuid>", type: "<table>", v: <record schema version>, iv, ct }
```

`ct` is the AES-GCM ciphertext (with tag) of the JSON-serialised record. **No financial field is stored or indexed in clear.** Searching and listing happen by decrypting into memory.

Versioning: `formatVersion` (container) and `v` (record schema, in the AAD) allow future migrations; unknown newer versions are rejected, never guessed. Database schema changes use Dexie `version(n)` upgrades.

### What remains visible without the password

Anyone with access to the browser profile can see, without the password:

- that a SpendFlow vault exists, its creation time, KDF parameters, salt (these are not secret);
- the **number of records per table** (`type`) and each record's **ciphertext length** (which loosely tracks content size);
- the random record ids; and database/object-store names.

They cannot read amounts, dates, categories, merchants, notes, account or loan details. The Settings page shows the live figures.

## 5. Session lifecycle and memory

- **Unlock:** derive key -> verify key-check ciphertext -> decrypt every record into an in-memory cache. Records that fail authentication are **skipped and reported** (never returned as data).
- **Lock:** waits for any in-flight write to finish (no half-written state), then drops the `CryptoKey` and cache references. Every store API then throws `VaultLockedError`; the UI unmounts the decrypted tree.
- **Triggers:** Lock button; inactivity (default 5 min, configurable); app hidden longer than a grace period (default 60 s, configurable; also checked against wall-clock time because phones suspend timers); page reload/close (the key is in memory only).
- **No data loss on lock:** all saved records are already persisted (encrypted). The only thing discarded is text typed into a form that was never submitted; if a dialog is open the inactivity lock is postponed once by 2 minutes.
- **Brute-force friction:** after 5 failed attempts the unlock screen enforces a growing wait (max 60 s). This is a cosmetic, client-side delay; it cannot stop an offline attacker, only PBKDF2 cost does.
- **Caveat: memory.** JavaScript offers no way to guarantee secure erasure. Dropping references makes the data unreachable to the application, but copies may linger until garbage collection and may exist in browser internals, swap files or crash dumps. Records are `Object.freeze`d in the cache so they cannot be mutated by accident. Do not treat "lock" as forensic erasure.

**Never stored** in localStorage, sessionStorage, IndexedDB, URLs or logs: the password, the derived key, any key material. `localStorage` holds exactly one value, `sf-theme` (light/dark) so the lock screen matches the theme. (An end-to-end test asserts this.)

## 6. Encrypted backups (format version 1)

A `.sfbackup.json` file:

```
{ "format": "spendflow-encrypted-backup", "formatVersion": 1,
  "createdAt": "...", "appSchemaVersion": 1, "cipher": "AES-256-GCM",
  "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": N, "salt": "<b64>" },
  "iv": "<b64>", "ciphertext": "<b64>" }
```

- The backup password is **independent** of the vault password. A fresh salt, key and nonce are generated per file; no vault key or nonce is reused.
- Only the header above is public. It contains **no record counts and nothing financial**: counts and contents are inside the ciphertext. The restore screen shows the header first, and the contents summary only after successful authentication.
- **Restore pipeline:** size and JSON check -> envelope schema + version check (unsupported versions rejected) -> KDF bounds check -> AES-GCM authentication -> payload schema validation (Zod) -> referential-integrity and duplicate-id checks -> preview -> explicit confirmation. Nothing touches the vault until the user confirms.
- **Replace** (typed `REPLACE` confirmation) encrypts the entire replacement set under the current key **first**, then swaps storage in a **single IndexedDB transaction**. **Merge** adds only missing records and never overwrites. If any step fails, the existing vault is unchanged (tested by injecting crypto and storage failures).
- AES-GCM cannot distinguish a wrong password from a modified file; both produce one message: "the password is wrong, or the file was modified or corrupted." Malformed or unsupported files get specific messages.
- Old **unencrypted** backups from earlier versions can still be *imported* (so nobody is locked out of old data); their content is encrypted in the vault. SpendFlow no longer *creates* them.
- CSV export/import remains for spreadsheet use. CSV is **not encrypted**; every CSV download requires an explicit confirmation saying so.

## 7. Password change and legacy migration

- **Change password:** requires the current password (verified against the stored key check), authenticates and decrypts **every** stored record with the old key (refuses to continue if any record fails, so data is never silently dropped), derives a new key from a new salt, re-encrypts everything, and swaps records and metadata in **one transaction**. On any failure the old password and data stay valid. Earlier backups keep their own password.
- **Legacy migration:** earlier versions stored plaintext in an IndexedDB database named `spendflow`. At first setup that data is encrypted into the vault, then verified by a real round trip (lock -> unlock from disk -> compare); only then is the plaintext database deleted. If verification fails the half-created vault is destroyed and the plaintext data is left untouched.

## 8. Application hardening

- **Content-Security-Policy** (production build, `<meta>` tag):
  `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'`.
  No inline scripts (the theme bootstrap is an external file), no `unsafe-eval`, no `unsafe-inline`, no remote origins; `connect-src 'self'` means injected code also could not send data to another origin via fetch/XHR/WebSocket. An end-to-end test proves inline script injection is blocked. **GitHub Pages cannot send HTTP headers**, so `frame-ancestors`, `report-uri` and header-only directives are unavailable; a meta CSP is the strongest option there.
- **XSS:** React renders user content as text; `dangerouslySetInnerHTML`, `innerHTML=`, `insertAdjacentHTML`, `eval` and `new Function` are banned by lint. An end-to-end test stores `<img onerror>`, `<script>` and `<svg onload>` payloads and verifies they display as literal text and never execute. CSV export neutralises spreadsheet formulas.
- **Dependencies:** 12 direct runtime dependencies (React, router, Dexie, Recharts, Zod, react-hook-form, PapaParse, lucide-react, clsx and small helpers). `npm audit` (production and dev) reported 0 vulnerabilities when this was written; re-run `npm audit` regularly. No analytics, no external fonts, no CDN scripts, no remote assets; the bundle contains no network calls to third parties.
- **Strict TypeScript:** `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, unused-code checks. All persisted and restored data is validated at runtime with Zod.
- **Fixtures:** the optional sample data is synthetic and flagged; no real financial data is in the repository, tests or screenshots.

## 9. Threat model

### Assets
Financial records (accounts, transactions, loans, budgets, goals, notes); the password; backup files.

### Protected scenarios

| Scenario | Outcome |
|---|---|
| Someone opens the site while the vault is **locked** (shared/lost device, curious family member, browser-profile copy) | Must guess the password. Data on disk is AES-256-GCM ciphertext; KDF cost slows guessing. |
| Another website | Same-origin isolation prevents access. |
| Network observer / hosting provider | Sees only that the static app was downloaded. No data is ever transmitted. |
| A stolen or shared **backup file** | Encrypted with its own password; header leaks no financial data. |
| Tampering with stored or backup ciphertext, swapping records, editing KDF parameters or headers | Detected by GCM authentication (AAD binding); bad records are never returned as data. |
| Mistakes (accidental restore, failed password change/restore) | Staged, atomic operations leave the previous vault intact; explicit confirmations. |

### Not protected (limitations, stated plainly)

1. **While unlocked, data is in memory in clear.** Anyone using your unlocked session can read it. Lock when you step away; use short timeouts.
2. **Malicious or compromised code running in the page** (XSS, a compromised dependency, a malicious browser extension with page access, or a compromised hosting repository/CI that ships altered JavaScript) can read decrypted data and the password as you type it. Client-side encryption **does not** defend against malicious application code. CSP, text-only rendering, minimal dependencies and a strict supply chain reduce the risk, but cannot remove it. Review releases you deploy and protect your GitHub account with 2FA.
3. **Malware / keyloggers / a compromised OS or browser** defeat any in-browser protection.
4. **Weak passwords.** PBKDF2 slows but does not stop an offline guesser who has a copy of the encrypted database or a backup file. The strength meter is a heuristic. Use a long passphrase (4+ unrelated words). A modern GPU can test many PBKDF2 guesses per second, and no KDF rescues a guessable password.
5. **Metadata** (existence, record counts per table, ciphertext sizes, timestamps of the vault) is visible (see section 4).
6. **Rollback and deletion:** an attacker who can write to your browser storage can delete records or restore an older (valid) ciphertext of a record. GCM authenticates individual records, not the completeness or freshness of the set.
7. **Memory remanence** after lock (see section 5), swap files and crash dumps.
8. **Data loss:** forgetting the password, clearing site data, or losing every backup is unrecoverable. There is deliberately no reset or backdoor.
9. **The password is not rate-limited server-side** (there is no server). The unlock delay is cosmetic.
10. **Metadata in the service worker / HTTP cache** concerns only the public app files, not financial data.
11. The unauthenticated **CSV** exports are plain text by design and confirmed each time.

## 10. Evidence

Run `npm test` and `npm run test:e2e`. Notable coverage:

- `src/vault/vault.test.ts`: correct/incorrect unlock; generic error messages; NFKC equivalence; throttling; locked-state API access (every store method throws); lock waits for in-flight writes; KDF-parameter DoS resistance; **no plaintext in raw IndexedDB** (scans every byte of every row for sentinel strings, field names and numbers; asserts the only index is `type`); unique salts and nonces (and a mocked-RNG test of the nonce guard); tamper detection (ciphertext bit-flip, nonce, tag truncation, version bump, swapped records, wrong table, modified key check/KDF params); atomic writes under callback and storage failure; concurrent writes; password change (re-encrypts everything, new salt, old password rejected, failure injection, refuses on unverifiable record); legacy migration including rollback; crypto round trips; AAD binding; unsupported Web Crypto.
- `src/db/db.test.ts`: encrypted backup round trip onto a fresh vault, header leaks nothing, wrong password / tampered ciphertext / tampered header / unsupported version / oversized / malformed files, invalid-but-authentic payloads, legacy plaintext import, **interrupted restore leaves the vault intact** (crypto and storage failure injection), plus all domain behaviour.
- `e2e/security.spec.ts` and `e2e/app.spec.ts`: setup validation, lock/unlock UX, nothing secret in localStorage/sessionStorage/URL/IndexedDB, change password in the UI, inactivity and hidden-app auto-lock (fake clock), CSP enforcement, XSS payloads, encrypted export -> wipe -> new vault -> restore (replace) through the real UI.

Mutation checks performed during development (each deliberately broke a safeguard and the suite failed): AAD that ignores record id/type; constant nonce; plaintext field persisted next to ciphertext.

## 11. Deployment notes

- Must be served over **HTTPS** (GitHub Pages is) or `localhost`: Web Crypto requires a secure context.
- Works at a repository sub-path (`https://<user>.github.io/<repo>/`); the CSP and theme bootstrap use relative URLs.
- Because the app is a static site, anyone who can push to the deploying branch can change the code users run. Restrict write access and branch protection on the `release` branch.

## 12. Recommended user practices

Use a long unique passphrase; keep an encrypted backup somewhere separate and remember its password; lock when away; keep the browser and OS updated; use a dedicated browser profile on shared computers; do not install untrusted extensions on the profile that holds the vault.
