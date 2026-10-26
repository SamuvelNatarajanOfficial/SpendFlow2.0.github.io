import { useEffect, useState, type FormEvent } from 'react'
import { KeyRound, Lock } from 'lucide-react'
import { useData } from '@/app/data'
import { StrengthMeter } from '@/app/VaultGate'
import { Field, fp, Notice, Section, useToast } from '@/components/ui'
import { updateSettings } from '@/db/repo'
import { assessPassword } from '@/vault/password'
import { VaultAuthError, VaultError, vault } from '@/vault/store'
import { formatBytes } from '@/lib/format'

const IDLE_OPTIONS = [1, 2, 5, 10, 15, 30, 60, 0]
const HIDE_OPTIONS: [number, string][] = [[0, 'Immediately'], [60, 'After 1 minute'], [300, 'After 5 minutes'], [-1, 'Never']]

export default function SecuritySection() {
  const d = useData()
  const toast = useToast()
  const [cur, setCur] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [meta, setMeta] = useState<{ rows: number; ciphertextBytes: number } | null>(null)

  useEffect(() => {
    vault.visibleMetadata().then(setMeta, () => undefined)
  }, [d.transactions.length, d.accounts.length])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    if (!cur) return setError('Enter your current password.')
    if (!assessPassword(pw).acceptable) return setError('Choose a stronger new password.')
    if (pw !== pw2) return setError('The new passwords do not match.')
    if (pw === cur) return setError('The new password must be different from the current one.')
    setBusy(true)
    try {
      await vault.changePassword(cur, pw)
      setCur('')
      setPw('')
      setPw2('')
      toast('Password changed. All data was re-encrypted.')
    } catch (err) {
      if (err instanceof VaultAuthError) setError('The current password is incorrect.')
      else if (err instanceof VaultError) setError(err.message)
      else setError('The password could not be changed. Your existing password and data are unchanged.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="Security" id="security" actions={<KeyRound size={18} className="text-subtle" />}>
      <div className="flex flex-wrap items-end gap-4">
        <button type="button" className="btn-secondary" onClick={() => void vault.lock()}><Lock size={16} /> Lock now</button>
        <div>
          <label htmlFor="idle" className="label">Lock after inactivity</label>
          <select id="idle" className="input !min-h-[40px] !w-auto" value={d.settings.autoLockMinutes ?? 5} onChange={(e) => updateSettings({ autoLockMinutes: +e.target.value })}>
            {IDLE_OPTIONS.map((n) => <option key={n} value={n}>{n === 0 ? 'Never' : `${n} minute${n > 1 ? 's' : ''}`}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="hide" className="label">Lock when app is hidden</label>
          <select id="hide" className="input !min-h-[40px] !w-auto" value={d.settings.lockOnHideSeconds ?? 60} onChange={(e) => updateSettings({ lockOnHideSeconds: +e.target.value })}>
            {HIDE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
      </div>
      <p className="mt-2 text-xs text-subtle">Locking never loses saved data: pending saves finish first. Text typed into a form you haven't submitted is discarded when the screen locks.</p>

      <form onSubmit={submit} noValidate className="mt-5 max-w-md space-y-3 border-t border-line pt-4" aria-label="Change password">
        <h3 className="text-sm font-bold">Change password</h3>
        <Field label="Current password" id="cp-cur"><input id="cp-cur" type="password" className="input" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
        <Field label="New password" id="cp-new"><input id="cp-new" type="password" className="input" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
        <StrengthMeter password={pw} />
        <Field label="Confirm new password" id="cp-new2" error={pw2 && pw !== pw2 ? 'Passwords do not match' : undefined}>
          <input {...fp('cp-new2', pw2 && pw !== pw2 ? 'x' : undefined)} type="password" className="input" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </Field>
        {error && <p role="alert" className="err">{error}</p>}
        <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Re-encrypting…' : 'Change password'}</button>
        <p className="text-xs text-subtle">Every record is re-encrypted with a new random salt and key, and swapped in as one all-or-nothing step. If anything fails, your old password keeps working. Backups you made earlier keep their own password.</p>
      </form>

      {meta && (
        <Notice>
          Without your password, someone with access to this browser can still see that a SpendFlow vault exists, roughly how many records it holds ({meta.rows}) and their total encrypted size ({formatBytes(meta.ciphertextBytes)}), but not their contents.
        </Notice>
      )}
    </Section>
  )
}
