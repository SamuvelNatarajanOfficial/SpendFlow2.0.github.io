import { useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { AlertTriangle, Database, Download, FlaskConical, Trash2, Upload } from 'lucide-react'
import { useData } from '@/app/data'
import { StrengthMeter } from '@/app/VaultGate'
import { Badge, Field, Notice, Section, useConfirm, useToast } from '@/components/ui'
import { usePlainExport } from '@/components/usePlainExport'
import {
  applyRestore, exportEncryptedBackup, inspectBackupFile, markBackupDone, openBackupFile, previewRestore, type FileStage, type OpenedBackup, type RestoreMode,
} from '@/db/backup'
import { downloadText, previewCsv, transactionsToCsv } from '@/db/csv'
import { applyCsvImport } from '@/db/importCsv'
import { clearAllData } from '@/db/repo'
import { countSample, loadSampleData, removeSampleData } from '@/db/sample'
import { formatDateTime } from '@/lib/dates'
import { formatINR } from '@/lib/money'
import { MAX_BACKUP_BYTES } from '@/vault/backupFile'
import { assessPassword } from '@/vault/password'

const readFile = (f: File) => f.text()

export default function DataSection() {
  const d = useData()
  const toast = useToast()
  const confirm = useConfirm()
  const plainExport = usePlainExport()
  const last = d.settings.lastBackupAt

  // ----- encrypted export -----
  const [bpw, setBpw] = useState('')
  const [bpw2, setBpw2] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')

  const doExport = async (e: FormEvent) => {
    e.preventDefault()
    setExportError('')
    if (!assessPassword(bpw).acceptable) return setExportError('Choose a stronger backup password (12+ characters).')
    if (bpw !== bpw2) return setExportError('The two passwords do not match.')
    setExporting(true)
    try {
      const { text, filename } = await exportEncryptedBackup(bpw)
      downloadText(filename, text, 'application/json')
      await markBackupDone()
      setBpw('')
      setBpw2('')
      toast('Encrypted backup downloaded')
    } catch {
      setExportError('The backup could not be created.')
    } finally {
      setExporting(false)
    }
  }

  // ----- restore -----
  const [file, setFile] = useState<{ name: string; text: string; stage: FileStage } | null>(null)
  const [rpw, setRpw] = useState('')
  const [opened, setOpened] = useState<OpenedBackup | null>(null)
  const [openErrors, setOpenErrors] = useState<string[]>([])
  const [opening, setOpening] = useState(false)
  const [mode, setMode] = useState<RestoreMode>('merge')
  const [report, setReport] = useState<string | null>(null)
  const restoreInput = useRef<HTMLInputElement>(null)

  const reset = () => {
    setFile(null)
    setOpened(null)
    setOpenErrors([])
    setRpw('')
  }

  const onRestoreFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    reset()
    setReport(null)
    if (f.size > MAX_BACKUP_BYTES) return setFile({ name: f.name, text: '', stage: { ok: false, message: 'The file is larger than 25 MB.' } })
    const text = await readFile(f)
    setFile({ name: f.name, text, stage: inspectBackupFile(text) })
  }

  const decrypt = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!file) return
    setOpening(true)
    setOpenErrors([])
    const r = await openBackupFile(file.text, rpw)
    setOpening(false)
    if (r.ok) {
      setOpened(r.opened)
      setRpw('')
    } else setOpenErrors(r.errors)
  }

  const preview = useMemo(() => (opened ? previewRestore(opened.backup, mode) : null), [opened, mode])

  const doRestore = async () => {
    if (!opened || !preview) return
    const adds = preview.tables.reduce((s, t) => s + t.added, 0)
    if (mode === 'replace') {
      const ok = await confirm({
        title: 'Replace ALL current data?',
        confirmLabel: 'Replace everything',
        requireText: 'REPLACE',
        message: <>This deletes <strong>{preview.willDelete}</strong> existing record(s) and restores <strong>{adds}</strong> from the backup. Nothing is changed until the backup has been fully decrypted and validated (it has been). Make sure you have a recent encrypted backup of the current data if you might need it.</>,
      })
      if (!ok) return
    } else {
      const ok = await confirm({
        title: 'Merge backup into current data?',
        confirmLabel: 'Merge',
        danger: false,
        message: <>{adds} new record(s) will be added. {preview.totalSkipped} record(s) already exist and are kept <strong>unchanged</strong> (nothing is overwritten).</>,
      })
      if (!ok) return
    }
    try {
      await applyRestore(opened.backup, mode)
      setReport(mode === 'replace' ? `Restore complete: replaced the vault with ${adds} record(s).` : `Merge complete: added ${adds} record(s), kept ${preview.totalSkipped} existing.`)
      toast(mode === 'replace' ? 'Backup restored' : `Merged ${adds} record(s)`)
      reset()
    } catch {
      toast('Restore failed. Your existing data was not changed.', 'error')
    }
  }

  // ----- CSV import -----
  const [csv, setCsv] = useState<{ name: string; text: string } | null>(null)
  const [defaultAcc, setDefaultAcc] = useState('')
  const [incDup, setIncDup] = useState(false)
  const csvPreview = useMemo(
    () => (csv ? previewCsv(csv.text, { accounts: d.accounts, categories: d.categories, existing: d.transactions, defaultAccountId: defaultAcc || undefined }) : null),
    [csv, d.accounts, d.categories, d.transactions, defaultAcc],
  )
  const onCsvFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (f.size > MAX_BACKUP_BYTES) return toast('File is larger than 25 MB', 'error')
    setCsv({ name: f.name, text: await readFile(f) })
  }
  const doCsv = async () => {
    if (!csvPreview) return
    const n = csvPreview.counts.ok + (incDup ? csvPreview.counts.duplicate : 0)
    if (n === 0) return toast('Nothing to import', 'error')
    const ok = await confirm({
      title: `Import ${n} transaction(s)?`, confirmLabel: 'Import', danger: false,
      message: <>{csvPreview.counts.error} row(s) with errors will be skipped{!incDup && csvPreview.counts.duplicate > 0 ? <>, {csvPreview.counts.duplicate} duplicate(s) skipped</> : null}.{csvPreview.newCategories.length > 0 && <> New categories will be created: {csvPreview.newCategories.map((c) => c.name).join(', ')}.</>}</>,
    })
    if (!ok) return
    try {
      const r = await applyCsvImport(csvPreview, incDup)
      toast(`Imported ${r.imported} transaction(s)`)
      setCsv(null)
    } catch (err) {
      toast(`Import failed: ${err instanceof Error ? err.message : err}`, 'error')
    }
  }

  // ----- sample / clear -----
  const sampleCount = useMemo(() => d.transactions.filter((t) => t.isSample).length + d.accounts.filter((a) => a.isSample).length, [d.transactions, d.accounts])
  const hasSample = d.settings.sampleLoaded || sampleCount > 0
  const realCount = d.transactions.filter((t) => !t.isSample).length

  const loadSample = async () => {
    if (realCount > 0 && !(await confirm({ title: 'Load sample data?', confirmLabel: 'Load sample data', danger: false, message: 'Sample records are added next to your real data, clearly flagged "Sample", and can be removed at any time without touching your own records.' }))) return
    await loadSampleData(d.today)
    toast('Sample data loaded')
  }
  const removeSample = async () => {
    const n = await countSample()
    if (await confirm({ title: 'Remove sample data?', confirmLabel: 'Remove sample data', message: `${n} sample record(s) will be deleted. Your own records are kept.` })) {
      await removeSampleData()
      toast('Sample data removed')
    }
  }
  const clearAll = async () => {
    const ok = await confirm({
      title: 'Delete ALL data?', confirmLabel: 'Delete everything', requireText: 'DELETE',
      message: <>This permanently erases the encrypted vault, every account, transaction, budget, loan and goal, <strong>and your password</strong>. You will return to first-time setup. It cannot be undone. <strong>Download an encrypted backup first</strong> if you might need this data.</>,
    })
    if (!ok) return
    await clearAllData()
  }

  const header = file?.stage.ok && file.stage.kind === 'encrypted' ? file.stage.header : null

  return (
    <div className="space-y-5" id="data">
      <Section title="Encrypted backup & recovery" id="backup" actions={<Database size={18} className="text-subtle" />}>
        <p className="text-sm">
          Last backup: <strong>{last ? formatDateTime(last, d.settings.timezone) : 'never'}</strong>{' '}
          {!last && d.transactions.length > 0 && <Badge tone="warn">Back up now</Badge>}
        </p>
        <p className="mt-1 text-sm text-subtle">Your data lives only in this browser. Clearing site data, uninstalling the browser or switching devices will lose it unless you have a backup. Backups are encrypted with a password you choose here (AES-256-GCM) and can be restored on any device. <strong>There is no way to recover a backup if its password is forgotten.</strong></p>

        <form onSubmit={doExport} noValidate className="mt-4 max-w-md space-y-3" aria-label="Create encrypted backup">
          <h3 className="text-sm font-bold">Create encrypted backup</h3>
          <Field label="Backup password" id="bk-pw"><input id="bk-pw" type="password" className="input" autoComplete="new-password" value={bpw} onChange={(e) => setBpw(e.target.value)} /></Field>
          <StrengthMeter password={bpw} />
          <Field label="Confirm backup password" id="bk-pw2"><input id="bk-pw2" type="password" className="input" autoComplete="new-password" value={bpw2} onChange={(e) => setBpw2(e.target.value)} /></Field>
          {exportError && <p role="alert" className="err">{exportError}</p>}
          <button type="submit" className="btn-primary" disabled={exporting}><Download size={16} /> {exporting ? 'Encrypting…' : 'Download encrypted backup'}</button>
        </form>

        <div className="mt-6 border-t border-line pt-4">
          <h3 className="text-sm font-bold">Restore from backup</h3>
          <p className="mt-1 text-xs text-subtle">Nothing is changed until the file is decrypted, authenticated and validated, you review the preview, and you confirm.</p>
          <button type="button" className="btn-secondary mt-3" onClick={() => restoreInput.current?.click()}><Upload size={16} /> Choose backup file…</button>
          <input ref={restoreInput} type="file" accept="application/json,.json" className="sr-only" aria-label="Backup file" onChange={onRestoreFile} />
          {report && <p role="status" className="mt-3 text-sm font-semibold text-pos">{report}</p>}

          {file && (
            <div className="mt-4 rounded-xl border border-line p-4" aria-live="polite" data-testid="restore-preview">
              <p className="text-sm font-semibold">{file.name}</p>
              {!file.stage.ok && (
                <div className="mt-2">
                  <Notice tone="neg">This file can't be restored. Nothing was changed.</Notice>
                  <p className="mt-2 text-sm text-neg">{file.stage.message}</p>
                </div>
              )}
              {file.stage.ok && !opened && (
                <form onSubmit={decrypt} noValidate className="mt-2 max-w-sm space-y-3">
                  {header ? (
                    <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-xs text-subtle">
                      <dt>Format</dt><dd>Encrypted SpendFlow backup v{header.formatVersion}</dd>
                      <dt>Created</dt><dd>{formatDateTime(header.createdAt, d.settings.timezone)}</dd>
                      <dt>Encryption</dt><dd>{header.cipher}, {header.kdf.name}-{header.kdf.hash} × {header.kdf.iterations.toLocaleString('en-IN')}</dd>
                    </dl>
                  ) : (
                    <Notice tone="warn">This is an old <strong>unencrypted</strong> SpendFlow backup. It can still be imported; its contents will be encrypted in your vault.</Notice>
                  )}
                  {header && <Field label="Backup password" id="rs-pw"><input id="rs-pw" type="password" className="input" autoComplete="off" value={rpw} onChange={(e) => setRpw(e.target.value)} autoFocus /></Field>}
                  {openErrors.length > 0 && <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-neg">{openErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
                  <div className="flex gap-2">
                    <button type="submit" className="btn-primary" disabled={opening || (!!header && !rpw)}>{opening ? 'Decrypting…' : header ? 'Decrypt and preview' : 'Validate and preview'}</button>
                    <button type="button" className="btn-secondary" onClick={reset}>Cancel</button>
                  </div>
                </form>
              )}
              {opened && preview && (
                <>
                  <p className="mt-1 text-xs text-subtle">Authenticated and validated · exported {formatDateTime(opened.backup.exportedAt, d.settings.timezone)}</p>
                  {opened.warnings.map((w) => <p key={w} className="mt-1 text-xs text-warn">{w}</p>)}
                  <fieldset className="mt-3">
                    <legend className="label">How should it be applied?</legend>
                    <div className="space-y-2 text-sm">
                      <label className="flex items-start gap-2"><input type="radio" name="mode" className="mt-1 accent-[rgb(var(--brand))]" checked={mode === 'merge'} onChange={() => setMode('merge')} /><span><strong>Merge</strong>: add missing records, keep everything that already exists (never overwrites).</span></label>
                      <label className="flex items-start gap-2"><input type="radio" name="mode" className="mt-1 accent-[rgb(var(--brand))]" checked={mode === 'replace'} onChange={() => setMode('replace')} /><span><strong>Replace</strong>: erase current data and restore exactly what is in the file.</span></label>
                    </div>
                  </fieldset>
                  <table className="mt-3 w-full text-sm">
                    <caption className="sr-only">Restore preview</caption>
                    <thead><tr className="text-left text-xs uppercase tracking-wide text-subtle"><th scope="col" className="py-1">Data</th><th scope="col" className="text-right">In file</th><th scope="col" className="text-right">{mode === 'merge' ? 'Will add' : 'Will restore'}</th><th scope="col" className="text-right">{mode === 'merge' ? 'Already here' : 'Will delete'}</th></tr></thead>
                    <tbody className="divide-y divide-line">
                      {preview.tables.map((t) => <tr key={t.key}><th scope="row" className="py-1 text-left font-medium capitalize">{t.key.replace(/([A-Z])/g, ' $1').toLowerCase()}</th><td className="num text-right">{t.incoming}</td><td className="num text-right font-semibold">{t.added}</td><td className="num text-right text-subtle">{mode === 'merge' ? t.skipped : t.existing}</td></tr>)}
                    </tbody>
                  </table>
                  <div className="mt-3 flex gap-2">
                    <button type="button" className={mode === 'replace' ? 'btn-danger' : 'btn-primary'} onClick={doRestore}>{mode === 'replace' ? 'Replace data…' : 'Merge backup…'}</button>
                    <button type="button" className="btn-secondary" onClick={reset}>Cancel</button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </Section>

      <Section title="CSV import & export">
        <Notice tone="warn">CSV files are <strong>not encrypted</strong>. Use them for spreadsheets or moving data from another tool; use the encrypted backup above to keep a protected copy.</Notice>
        <div className="mt-3 flex flex-wrap gap-3">
          <button type="button" className="btn-secondary" disabled={d.transactions.length === 0} onClick={() => plainExport('spendflow-transactions.csv', transactionsToCsv(d.transactions, d.accounts, d.categories))}><Download size={16} /> Export all transactions (unencrypted CSV)</button>
          <label className="btn-secondary cursor-pointer">
            <Upload size={16} /> Import transactions (CSV)…
            <input type="file" accept=".csv,text/csv" className="sr-only" aria-label="CSV file" onChange={onCsvFile} />
          </label>
        </div>
        <p className="mt-2 text-xs text-subtle">Columns: date, type (income/expense/transfer), amount, category, account, to_account, payment_method, merchant, notes. Dates: YYYY-MM-DD or DD/MM/YYYY. Accounts must already exist.</p>

        {csv && csvPreview && (
          <div className="mt-4 rounded-xl border border-line p-4" aria-live="polite" data-testid="csv-preview">
            <p className="text-sm font-semibold">{csv.name}</p>
            {csvPreview.fatal.length > 0 ? (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-neg">{csvPreview.fatal.map((e, i) => <li key={i}>{e}</li>)}</ul>
            ) : (
              <>
                <p className="mt-1 text-sm"><Badge tone="pos">{csvPreview.counts.ok} ready</Badge> <Badge tone="warn">{csvPreview.counts.duplicate} duplicate</Badge> <Badge tone="neg">{csvPreview.counts.error} errors</Badge></p>
                <div className="mt-3 flex flex-wrap items-end gap-4">
                  <div>
                    <label htmlFor="csv-acc" className="label">Account for rows without one</label>
                    <select id="csv-acc" className="input !min-h-[38px] !w-auto" value={defaultAcc} onChange={(e) => setDefaultAcc(e.target.value)}>
                      <option value="">None (rows are errors)</option>
                      {d.accounts.filter((a) => !a.archived).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </div>
                  {csvPreview.counts.duplicate > 0 && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[rgb(var(--brand))]" checked={incDup} onChange={(e) => setIncDup(e.target.checked)} /> Import duplicates anyway</label>}
                </div>
                {csvPreview.newCategories.length > 0 && <p className="mt-2 text-xs text-subtle">New categories to create: {csvPreview.newCategories.map((c) => c.name).join(', ')}</p>}
                <div className="mt-3 max-h-64 overflow-auto rounded-lg border border-line">
                  <table className="w-full min-w-[520px] text-xs">
                    <caption className="sr-only">Import preview (first 100 rows)</caption>
                    <thead className="sticky top-0 bg-muted text-left uppercase tracking-wide text-subtle"><tr><th scope="col" className="p-2">Line</th><th scope="col">Status</th><th scope="col">Date</th><th scope="col">Type</th><th scope="col" className="text-right">Amount</th><th scope="col" className="p-2">Details</th></tr></thead>
                    <tbody className="divide-y divide-line">
                      {csvPreview.rows.slice(0, 100).map((r) => (
                        <tr key={r.line}>
                          <td className="p-2">{r.line}</td>
                          <td>{r.status === 'ok' ? <Badge tone="pos">OK</Badge> : r.status === 'duplicate' ? <Badge tone="warn">Duplicate</Badge> : <Badge tone="neg">Error</Badge>}</td>
                          <td>{r.tx?.date ?? '—'}</td><td className="capitalize">{r.tx?.type ?? '—'}</td>
                          <td className="num text-right">{r.tx ? formatINR(r.tx.amount) : '—'}</td>
                          <td className="p-2 text-neg">{r.errors.join('; ')}{r.status === 'duplicate' && <span className="text-warn">Matches {r.duplicateOf === 'file' ? 'an earlier row in this file' : 'an existing transaction'}</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {csvPreview.rows.length > 100 && <p className="mt-1 text-xs text-subtle">Showing first 100 of {csvPreview.rows.length} rows.</p>}
                <div className="mt-3 flex gap-2">
                  <button type="button" className="btn-primary" onClick={doCsv}>Import {csvPreview.counts.ok + (incDup ? csvPreview.counts.duplicate : 0)} transaction(s)…</button>
                  <button type="button" className="btn-secondary" onClick={() => setCsv(null)}>Cancel</button>
                </div>
              </>
            )}
            {csvPreview.fatal.length > 0 && <button type="button" className="btn-secondary mt-3" onClick={() => setCsv(null)}>Close</button>}
          </div>
        )}
      </Section>

      <Section title="Sample data" actions={<FlaskConical size={18} className="text-subtle" />}>
        <p className="text-sm text-subtle">Load a small demo dataset (accounts, transactions, budgets, loans and goals) to explore the app. Sample records are flagged and kept separate: removing them never deletes your own data.</p>
        <div className="mt-3 flex flex-wrap gap-3">
          <button type="button" className="btn-secondary" onClick={loadSample} disabled={hasSample}>Load sample data</button>
          <button type="button" className="btn-secondary" onClick={removeSample} disabled={!hasSample}>Remove sample data</button>
        </div>
      </Section>

      <Section title="Danger zone" actions={<AlertTriangle size={18} className="text-neg" />}>
        <p className="text-sm text-subtle">Permanently delete the encrypted vault, all data and the password stored in this browser.</p>
        <button type="button" className="btn-danger mt-3" onClick={clearAll}><Trash2 size={16} /> Delete all data…</button>
      </Section>
    </div>
  )
}
