import { useMemo, useRef, useState, type ChangeEvent } from 'react'
import { AlertTriangle, Database, Download, FlaskConical, Trash2, Upload } from 'lucide-react'
import { useData } from '@/app/data'
import { Badge, Notice, Section, useConfirm, useToast } from '@/components/ui'
import { applyRestore, exportBackupJson, markBackupDone, parseBackup, previewRestore, type ParseResult, type RestoreMode, type RestorePreview } from '@/db/backup'
import { downloadText, previewCsv, transactionsToCsv } from '@/db/csv'
import { applyCsvImport } from '@/db/importCsv'
import { clearAllData, updateSettings } from '@/db/repo'
import { countSample, loadSampleData, removeSampleData } from '@/db/sample'
import { formatDateTime } from '@/lib/dates'
import { formatINR } from '@/lib/money'

const readFile = (f: File) => f.text()
const MAX_BYTES = 25 * 1024 * 1024

export async function downloadBackup(): Promise<void> {
  const { json, filename } = await exportBackupJson()
  downloadText(filename, json, 'application/json')
  await markBackupDone()
}

export default function DataSection() {
  const d = useData()
  const toast = useToast()
  const confirm = useConfirm()
  const last = d.settings.lastBackupAt

  // ----- restore -----
  const [parsed, setParsed] = useState<{ name: string; result: ParseResult } | null>(null)
  const [mode, setMode] = useState<RestoreMode>('merge')
  const [preview, setPreview] = useState<RestorePreview | null>(null)
  const restoreInput = useRef<HTMLInputElement>(null)

  const onRestoreFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (f.size > MAX_BYTES) return setParsed({ name: f.name, result: { ok: false, errors: ['File is larger than 25 MB.'] } })
    const result = parseBackup(await readFile(f))
    setParsed({ name: f.name, result })
    setPreview(result.ok ? await previewRestore(result.backup, mode) : null)
  }
  const changeMode = async (m: RestoreMode) => {
    setMode(m)
    if (parsed?.result.ok) setPreview(await previewRestore(parsed.result.backup, m))
  }
  const doRestore = async () => {
    if (!parsed?.result.ok || !preview) return
    const b = parsed.result.backup
    const adds = preview.tables.reduce((s, t) => s + t.added, 0)
    if (mode === 'replace') {
      const ok = await confirm({
        title: 'Replace ALL current data?',
        confirmLabel: 'Replace everything',
        requireText: 'REPLACE',
        message: <>This deletes <strong>{preview.willDelete}</strong> existing record(s) and restores <strong>{adds}</strong> from the backup. A safety backup of your current data will be downloaded first.</>,
      })
      if (!ok) return
      if (preview.willDelete > 0) await downloadBackup()
    } else {
      const ok = await confirm({
        title: 'Merge backup into current data?',
        confirmLabel: 'Merge',
        danger: false,
        message: <>{adds} new record(s) will be added. {preview.totalSkipped} record(s) already exist and will be kept <strong>unchanged</strong> (nothing is overwritten).</>,
      })
      if (!ok) return
    }
    try {
      await applyRestore(b, mode)
      toast(mode === 'replace' ? 'Backup restored' : `Merged ${adds} record(s)`)
      setParsed(null)
      setPreview(null)
    } catch (err) {
      toast(`Restore failed: ${err instanceof Error ? err.message : err}. Your data was not changed.`, 'error')
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
    if (f.size > MAX_BYTES) return toast('File is larger than 25 MB', 'error')
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
      message: <>This permanently erases every account, transaction, budget, loan and goal stored in this browser. It cannot be undone. <strong>Download a backup first</strong> if you might need this data.</>,
    })
    if (!ok) return
    await clearAllData()
    await updateSettings({ sampleLoaded: false, lastBackupAt: undefined })
    toast('All data deleted')
  }

  return (
    <div className="space-y-5" id="data">
      <Section title="Backup & recovery" id="backup" actions={<Database size={18} className="text-subtle" />}>
        <p className="text-sm">
          Last backup: <strong>{last ? formatDateTime(last, d.settings.timezone) : 'never'}</strong>{' '}
          {!last && d.transactions.length > 0 && <Badge tone="warn">Back up now</Badge>}
        </p>
        <p className="mt-1 text-sm text-subtle">Your data lives only in this browser. Clearing site data, uninstalling the browser or switching devices will lose it unless you have a backup file. Store backups somewhere safe: they contain your financial records in plain text.</p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <button type="button" className="btn-primary" onClick={async () => { await downloadBackup(); toast('Backup downloaded') }}><Download size={16} /> Download full backup (JSON)</button>
          <button type="button" className="btn-secondary" onClick={() => restoreInput.current?.click()}><Upload size={16} /> Restore from backup…</button>
          <input ref={restoreInput} type="file" accept="application/json,.json" className="sr-only" aria-label="Backup file" onChange={onRestoreFile} />
          <div>
            <label htmlFor="remind" className="label">Remind me every</label>
            <select id="remind" className="input !min-h-[40px] !w-auto" value={d.settings.backupReminderDays} onChange={(e) => updateSettings({ backupReminderDays: +e.target.value })}>
              {[1, 3, 7, 14, 30].map((n) => <option key={n} value={n}>{n} day{n > 1 ? 's' : ''}</option>)}
            </select>
          </div>
        </div>

        {parsed && (
          <div className="mt-4 rounded-xl border border-line p-4" aria-live="polite" data-testid="restore-preview">
            <p className="text-sm font-semibold">{parsed.name}</p>
            {!parsed.result.ok ? (
              <div className="mt-2">
                <Notice tone="neg">This file can't be restored. Nothing was changed.</Notice>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-neg">{parsed.result.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
              </div>
            ) : (
              <>
                <p className="mt-1 text-xs text-subtle">Valid SpendFlow backup · schema v{parsed.result.backup.schemaVersion} · exported {formatDateTime(parsed.result.backup.exportedAt, d.settings.timezone)}</p>
                {parsed.result.warnings.map((w) => <p key={w} className="mt-1 text-xs text-warn">{w}</p>)}
                <fieldset className="mt-3">
                  <legend className="label">How should it be applied?</legend>
                  <div className="space-y-2 text-sm">
                    <label className="flex items-start gap-2"><input type="radio" name="mode" className="mt-1 accent-[rgb(var(--brand))]" checked={mode === 'merge'} onChange={() => changeMode('merge')} /><span><strong>Merge</strong>: add missing records, keep everything that already exists (never overwrites).</span></label>
                    <label className="flex items-start gap-2"><input type="radio" name="mode" className="mt-1 accent-[rgb(var(--brand))]" checked={mode === 'replace'} onChange={() => changeMode('replace')} /><span><strong>Replace</strong>: erase current data and restore exactly what is in the file.</span></label>
                  </div>
                </fieldset>
                {preview && (
                  <table className="mt-3 w-full text-sm">
                    <caption className="sr-only">Restore preview</caption>
                    <thead><tr className="text-left text-xs uppercase tracking-wide text-subtle"><th scope="col" className="py-1">Data</th><th scope="col" className="text-right">In file</th><th scope="col" className="text-right">{mode === 'merge' ? 'Will add' : 'Will restore'}</th><th scope="col" className="text-right">{mode === 'merge' ? 'Already here' : 'Will delete'}</th></tr></thead>
                    <tbody className="divide-y divide-line">
                      {preview.tables.map((t) => <tr key={t.key}><th scope="row" className="py-1 text-left font-medium capitalize">{t.key.replace(/([A-Z])/g, ' $1').toLowerCase()}</th><td className="num text-right">{t.incoming}</td><td className="num text-right font-semibold">{t.added}</td><td className="num text-right text-subtle">{mode === 'merge' ? t.skipped : t.existing}</td></tr>)}
                    </tbody>
                  </table>
                )}
                <div className="mt-3 flex gap-2">
                  <button type="button" className={mode === 'replace' ? 'btn-danger' : 'btn-primary'} onClick={doRestore}>{mode === 'replace' ? 'Replace data…' : 'Merge backup…'}</button>
                  <button type="button" className="btn-secondary" onClick={() => { setParsed(null); setPreview(null) }}>Cancel</button>
                </div>
              </>
            )}
          </div>
        )}
      </Section>

      <Section title="CSV import & export">
        <div className="flex flex-wrap gap-3">
          <button type="button" className="btn-secondary" disabled={d.transactions.length === 0} onClick={() => downloadText('spendflow-transactions.csv', transactionsToCsv(d.transactions, d.accounts, d.categories), 'text/csv')}><Download size={16} /> Export all transactions (CSV)</button>
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
        <p className="text-sm text-subtle">Permanently delete everything stored by SpendFlow in this browser.</p>
        <button type="button" className="btn-danger mt-3" onClick={clearAll}><Trash2 size={16} /> Delete all data…</button>
      </Section>
    </div>
  )
}
