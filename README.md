# SpendFlow 2.0

**Every rupee. Every goal. Under control.** A local-first personal finance manager (web + installable PWA) for tracking income, expenses, accounts, budgets, loans/EMIs and goals. No backend, no subscription: all data lives in your browser (IndexedDB) and is **encrypted with a password you choose** (AES-256-GCM). See [docs/SECURITY.md](docs/SECURITY.md) for the architecture and threat model.

## Features

- **Dashboard**: total balance, income, expenses, net savings and savings rate for *this month / last month / this year / custom*; income-vs-expense chart, category donut, budget progress, upcoming EMIs and recurring bills, recent transactions, goal and debt progress. Every figure is computed from stored data.
- **Income & Expenses**: add/edit/delete (with confirmation), search, filter by date/category/account, essential vs discretionary, recurring, custom categories, CSV export.
- **Accounts & transfers**: cash, savings, current, UPI and custom accounts with opening balances. Transfers move money between accounts and are **never** counted as income or expense. Optional reconciliation shows *calculated* vs *actual bank* balance.
- **Recurring**: every repeating income/expense in one list with its next due date. Press **Record** to post a due item as a real transaction (also available from the Dashboard), or **Stop** to end the series. Month-end dates don't drift (31 Jan → 28 Feb → 31 Mar).
- **Budgets**: per-category monthly budgets, spent/remaining/percent, over-budget warnings, copy last month, 3-month comparison.
- **Loans & EMI**: multiple loans, interest/principal split per payment, extra-principal payments, payment history, estimated amortisation schedule, editable repayment plan with payoff comparison, manual outstanding-balance correction.
- **Goals**: emergency fund, savings, major purchase, custom, and an automatic debt-free goal derived from your loans.
- **Reports**: monthly/yearly tables and charts, category analysis, savings-rate trend, budget vs actual, loan balance trend; CSV exports.
- **Security**: password-protected encrypted vault, lock screen, inactivity and app-hidden auto-lock, password change that re-encrypts everything, strength guidance.
- **Backup & recovery**: password-protected **encrypted** backup files (versioned, authenticated), restore with metadata-only preview and typed confirmation (merge or replace), CSV import with preview/validation/duplicate detection, last-backup date and reminder banner.
- **Settings**: INR / Asia/Kolkata, light/dark theme, categories, accounts, sample data (flagged and removable), clear-all with typed confirmation.

## Design decisions & assumptions

- **Money** is stored as integer paise; display uses `en-IN` grouping (₹1,23,456.78). Input is parsed with string arithmetic, never floats.
- **Dates** are `YYYY-MM-DD` calendar dates; "today" is computed in the configured timezone (default Asia/Kolkata).
- **No double counting**
  - Transfers affect two account balances but not income/expense totals.
  - A loan payment is stored once as a payment; it creates *one* linked expense (category "EMI & Loans") only if you choose an account. That expense can only be changed from the Loans page.
  - Goals are *earmarks* of money already inside an account. They are never added to the total balance; over-allocation is flagged.
- **Loan model**: fixed-rate, reducing-balance, monthly interest = outstanding × annual rate ÷ 12 (rounded to paise). An EMI pays interest first and only the remainder reduces principal. Real lenders may use day-count conventions, fees, moratoria or rate resets, so schedules are **estimates**. Correct the outstanding balance from your statement at any time. Historic loan trend charts are reconstructed from recorded payments and ignore later manual corrections.
- **Recurring** items are never auto-posted. A series is every recurring entry with the same type, category, merchant, amount and frequency; the next due date comes from its latest entry. You press **Record** (only allowed once due; it can't create duplicate dates) and **Stop** clears the flag on the whole series without touching existing transactions. Editing an amount or merchant starts a new series.
- Built-in categories have deterministic IDs so backups merge cleanly across devices.

## Privacy & security

- Nothing is sent to any server, analytics service or API. There are no keys or secrets in the code, no third-party scripts, fonts or CDNs, and a strict Content-Security-Policy blocks other origins.
- **Your data is encrypted at rest in the browser.** On first run you create a password. Every record is encrypted (AES-256-GCM, key derived with PBKDF2-HMAC-SHA-256, 600,000+ iterations calibrated to your device) before it is written to IndexedDB. The key lives only in memory and is dropped when the vault locks. Reloading the page locks it.
- **There is no password recovery.** If you forget it, the data can only be restored from an encrypted backup (which has its own password). Keep a backup.
- Encryption protects data **while the vault is locked**. While unlocked, decrypted data is in memory, so anyone using your unlocked session, or malicious code running in the page or a browser extension, can read it. Lock when you step away. IndexedDB record counts and sizes remain visible to someone with access to the browser profile. Clearing site data can erase everything. See [docs/SECURITY.md](docs/SECURITY.md) for the full threat model and limitations.
- Never enter bank credentials, UPI PINs, OTPs or card details. The app does not need them and does not connect to banks.
- The app asks the browser for persistent storage (best effort) to reduce eviction risk.
- **Upgrading from an earlier (unencrypted) version:** on first launch the setup screen detects your existing data, encrypts it into the new vault, verifies it, and only then deletes the old plaintext copy.

## Local development

```bash
npm install
npm run dev            # http://localhost:5173
npm run lint
npm run typecheck
npm test               # Vitest unit + database tests
npm run build          # type-check + production build into dist/
npm run preview        # serve the production build on :4173
npx playwright install chromium   # first time only
npm run test:e2e       # builds, serves the production bundle, runs Playwright
npm run icons          # regenerate PNG icons from public/favicon.svg
```

Node 20+ recommended (developed on Node 24).

## Deploy to GitHub Pages

1. Create a GitHub repository and push this project (create a `release` branch from it). (The workflow is in `.github/workflows/deploy.yml`.)
2. In the repo go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. Push to `release`. The workflow installs dependencies, runs lint, type-check, unit tests and Playwright tests, builds, and deploys `dist/`. Pull requests run the checks but don't deploy.
4. Your app is served at `https://<username>.github.io/<repository-name>/`.

How it avoids path problems on Pages:
- Vite `base` is `./` (override with the `VITE_BASE` env var, e.g. `VITE_BASE=/my-repo/`), so assets, manifest, icons and the service worker all resolve under any repository path.
- Routing uses the URL hash (`/#/loans`), so refreshing or deep-linking never 404s on a static host.
- Verified by serving the built `dist/` under `/SpendFlow2.0.github.io/`: no failed requests, service-worker scope correct, manifest icons load.

## Install as an app

- **Android (Chrome/Edge/Samsung Internet)**: open the site → menu (⋮) → *Install app* / *Add to Home screen*.
- **Desktop Chrome/Edge**: click the install icon at the right of the address bar (or menu → *Install SpendFlow*).
- **iPhone/iPad (Safari)**: Share → *Add to Home Screen*.

Core features work offline after the first load. When a new version is available a prompt appears; it never reloads on its own, so you can finish what you're doing first. Your data is stored separately from the app files and isn't touched by updates.

## Backup & restore

- **Settings → Encrypted backup & recovery → Download encrypted backup** asks for a backup password (independent of the vault password; the strength meter applies) and writes `spendflow-backup-YYYY-MM-DD.sfbackup.json`. The "last backup" date updates only after the download is triggered, and a banner reminds you after the chosen number of days. There is **no unencrypted JSON export**.
- **Restore**: choose the file; the public header (format version, date, algorithm) is shown without a password; enter the backup password to decrypt and authenticate; the content is validated against the schema; then you see a preview. *Merge* only adds missing records and never overwrites; *Replace* requires typing `REPLACE`. Nothing in your vault changes until you confirm, and a failure at any point leaves your existing data intact. A backup can be restored on any device: create a vault there first, then restore.
- Old unencrypted backups from earlier versions can still be imported (they become encrypted in the vault).
- **CSV** export is for spreadsheets and is **not encrypted**; every CSV download asks you to confirm that. CSV import columns: `date, type, amount, category, account, to_account, payment_method, merchant, notes` (dates `YYYY-MM-DD` or `DD/MM/YYYY`). The preview lists per-line errors and duplicates; duplicates are skipped unless you opt in. New categories are created; accounts must already exist.

## Project layout

```
src/lib/        money, dates, and pure calculation modules (calc/ledger, budget, loan, goals, reports)
src/vault/      crypto primitives, encrypted vault store, encrypted backup file, legacy migration, password policy
src/db/         Zod schemas, repositories (repo.ts), backup payload logic, CSV, sample data
docs/           SECURITY.md (architecture + threat model)
src/features/   pages (Dashboard, Transactions, Accounts, Budgets, Loans, Goals, Reports, Settings)
src/components/ shared UI (modal/confirm/toast, forms, charts)
e2e/            Playwright tests (production build)
```

Schema changes: records are JSON inside ciphertext, so evolve them with Zod schemas (`src/db/schemas.ts`), bump `RECORD_SCHEMA_VERSION` (`src/vault/crypto.ts`) and `BACKUP_SCHEMA_VERSION` with a migration in `parseBackup` / on unlock. Changes to the IndexedDB container itself use a new `this.version(n)` in `src/vault/store.ts` (never edit a released version).

## Testing

- **Unit/database (Vitest, fake-indexeddb)**: money & date handling, balances and transfers, budgets, savings rate, loan interest/amortisation/plans, goals, reports, date filtering, recurring items, CSV import/export, persistence, sample data, and the security layer: unlock/lock, wrong password, tampered ciphertext/headers, unique salts and nonces, encryption round trips, **no plaintext in raw IndexedDB**, encrypted backup round trip / wrong password / corrupted / unsupported / interrupted restore, password change, legacy migration, locked-state API access.
- **End-to-end (Playwright, production build)**: first-run setup validation, lock/unlock, nothing secret in browser storage, password change, inactivity and hidden-app auto-lock (fake clock), CSP enforcement and XSS payloads rendered as text, add income, record expense, create budget, record EMI, recurring items, encrypted backup → wipe → new vault → restore, CSV import, theme persistence, refresh on deep routes, all pages free of console errors / failed requests, no horizontal scroll at phone width, offline reload via service worker.
- The tests use a deliberately tiny PBKDF2 cost (set in `src/test/setup.ts`) for speed. The frozen production policy (≥ 600,000 iterations) is asserted separately.

## Limitations & ideas

- Single device/browser: there is no sync. Move data between devices with backup files.
- **No password recovery** and no multi-device sync: move data between devices with encrypted backups. There is no biometric/WebAuthn unlock yet.
- PBKDF2 is not memory-hard (Web Crypto has no Argon2/scrypt); a strong passphrase matters. Client-side encryption cannot protect against malicious code running in the page while the vault is unlocked. See [docs/SECURITY.md](docs/SECURITY.md).
- Recurring items are recorded with one click, not automatically. Catching up several missed periods means pressing Record once per period.
- Loan schedules are estimates (see assumptions); floating-rate loans need manual correction.
- Single currency (INR). Multi-currency, bank-statement PDF import and account-level transaction search are future work.
- Charts are accessible via adjacent tables for the main reports, but screen-reader support for the chart graphics themselves is basic.

## Troubleshooting

- **"Storage is unavailable"**: IndexedDB is blocked (private window or strict site-data settings). Use a normal window and allow site data.
- **I forgot my password**: it cannot be recovered. On the unlock screen choose *Forgot your password?* → *Erase vault and start over*, set a new password, then restore your latest encrypted backup (you need the backup's password).
- **Unlocking takes a second or two**: that is the key derivation, calibrated for your device. It is the main defence against password guessing.
- **"Can't run securely here"**: the browser lacks Web Crypto or the page is not on HTTPS/localhost. There is no insecure fallback by design.
- **My data disappeared**: browser data was cleared or you're in a different browser profile. Restore your latest encrypted backup.
- **App doesn't update**: close all tabs of the app and reopen, or accept the *Update now* prompt. In DevTools → Application → Service Workers you can *Unregister* (data stays).
- **E2E tests reuse an old build**: Playwright reuses a server already on port 4173. Stop it (or run `npm run build` first) so tests run against current code.
- **`npm install` fails with a native-binding error**: delete `node_modules` and `package-lock.json`, then reinstall (a known npm optional-dependency bug).
