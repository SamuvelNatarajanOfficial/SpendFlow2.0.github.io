import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import { Eye, EyeOff, Lock, ShieldCheck } from 'lucide-react'
import clsx from 'clsx'
import { Field, fp, Notice, useConfirm } from '@/components/ui'
import { cryptoSupport } from '@/vault/crypto'
import { detectLegacy, setupVault, type LegacyInfo } from '@/vault/legacy'
import { assessPassword } from '@/vault/password'
import { VaultAuthError, vault } from '@/vault/store'

/** Renders children only while the vault is unlocked. Everything else is a setup / unlock / error screen. */
export function VaultGate({ children }: { children: ReactNode }) {
  const status = useSyncExternalStore(vault.subscribe, vault.getStatus)
  const support = useMemo(() => cryptoSupport(), [])
  const [initError, setInitError] = useState(false)

  useEffect(() => {
    if (support.ok) vault.init().catch(() => setInitError(true))
  }, [support])

  if (!support.ok) {
    return (
      <Shell title="Can't run securely here">
        <p role="alert" className="text-sm text-subtle">
          {support.reason} SpendFlow will not store financial data without encryption, and there is no insecure fallback. Open the app over HTTPS (or localhost) in an up-to-date browser.
        </p>
      </Shell>
    )
  }
  if (initError) {
    return (
      <Shell title="Storage is unavailable">
        <p role="alert" className="text-sm text-subtle">
          SpendFlow could not open the browser database. Private/incognito windows and some browser settings block IndexedDB. Open the app in a regular window and allow site data.
        </p>
      </Shell>
    )
  }
  if (status === 'unknown') return <div className="grid min-h-screen place-items-center text-subtle" role="status">Loading…</div>
  if (status === 'uninitialized') return <SetupScreen />
  if (status === 'locked') return <UnlockScreen />
  return <>{children}</>
}

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="card w-full max-w-md p-6">
        <div className="mb-5 flex items-center gap-3">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="h-10 w-10 rounded-xl" />
          <div>
            <p className="text-sm font-bold">SpendFlow <span className="text-brand">2.0</span></p>
            <h1 className="text-xl font-bold tracking-tight">{title}</h1>
          </div>
        </div>
        {children}
      </div>
    </main>
  )
}

function PasswordInput({ id, value, onChange, autoComplete, autoFocus, error, label }: { id: string; value: string; onChange: (v: string) => void; autoComplete: string; autoFocus?: boolean; error?: string; label: string }) {
  const [show, setShow] = useState(false)
  return (
    <Field label={label} id={id} error={error}>
      <div className="relative">
        <input {...fp(id, error)} type={show ? 'text' : 'password'} className="input !pr-11" value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} autoFocus={autoFocus} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
        <button type="button" className="absolute right-1 top-1 grid h-9 w-9 place-items-center rounded-lg text-subtle hover:text-fg" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </Field>
  )
}

export function StrengthMeter({ password }: { password: string }) {
  const a = useMemo(() => assessPassword(password), [password])
  if (!password) return null
  const color = a.score <= 1 ? 'bg-neg' : a.score === 2 ? 'bg-warn' : 'bg-pos'
  return (
    <div aria-live="polite">
      <div className="flex gap-1" aria-hidden>
        {[0, 1, 2, 3].map((i) => <span key={i} className={clsx('h-1.5 flex-1 rounded-full', i < Math.max(1, a.score) ? color : 'bg-muted')} />)}
      </div>
      <p className="mt-1 text-xs font-semibold">Strength: {a.label}{a.acceptable ? '' : ' (not accepted yet)'}</p>
      {a.hints.length > 0 && <ul className="mt-0.5 list-disc pl-4 text-xs text-subtle">{a.hints.map((h) => <li key={h}>{h}</li>)}</ul>}
    </div>
  )
}

function SetupScreen() {
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [legacy, setLegacy] = useState<LegacyInfo | null>(null)

  useEffect(() => {
    detectLegacy().then(setLegacy, () => undefined)
  }, [])

  const a = assessPassword(pw)
  const mismatch = pw2.length > 0 && pw !== pw2

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    if (!a.acceptable) return setError('Choose a stronger password (see the guidance below the field).')
    if (pw !== pw2) return setError('The two passwords do not match.')
    if (!ack) return setError('Please confirm that you understand there is no password recovery.')
    setBusy(true)
    try {
      await setupVault(pw)
      // on success the vault is unlocked and the gate swaps to the app
    } catch (err) {
      setError(err instanceof Error && err.message.startsWith('Migrating') ? err.message : 'Could not create the vault. Please try again.')
      setBusy(false)
    }
  }

  return (
    <Shell title="Protect your data">
      <form onSubmit={submit} noValidate className="space-y-4">
        <p className="text-sm text-subtle">
          Create a password. Your records are encrypted on this device (AES-256-GCM, key derived from your password) before they are stored. Nothing is sent anywhere.
        </p>
        {legacy && (
          <Notice tone="warn">
            Found <strong>{legacy.records}</strong> existing unencrypted record(s) on this device. They will be encrypted into your new vault and the unencrypted copy deleted once the encrypted copy is verified.
          </Notice>
        )}
        <PasswordInput id="setup-pw" label="Password" value={pw} onChange={setPw} autoComplete="new-password" autoFocus />
        <StrengthMeter password={pw} />
        <PasswordInput id="setup-pw2" label="Confirm password" value={pw2} onChange={setPw2} autoComplete="new-password" error={mismatch ? 'Passwords do not match' : undefined} />
        <p className="text-xs text-subtle">Tip: a passphrase of four or more unrelated words is both strong and easy to remember.</p>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1 h-4 w-4 accent-[rgb(var(--brand))]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>I understand there is <strong>no password recovery</strong>. If I forget it, my data can only be restored from an encrypted backup.</span>
        </label>
        {error && <p role="alert" className="err">{error}</p>}
        <button type="submit" className="btn-primary w-full" disabled={busy}>
          <ShieldCheck size={16} /> {busy ? 'Encrypting…' : 'Create encrypted vault'}
        </button>
      </form>
    </Shell>
  )
}

function UnlockScreen() {
  const confirm = useConfirm()
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [help, setHelp] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!pw) return setError('Enter your password.')
    setBusy(true)
    setError('')
    try {
      await vault.unlock(pw)
      setPw('')
    } catch (err) {
      const wait = err instanceof VaultAuthError && err.retryAfterMs ? Math.ceil(err.retryAfterMs / 1000) : 0
      // same message for every failure: never reveals whether the password or the data was the problem
      setError(wait ? `Incorrect password, or the vault could not be unlocked. Too many attempts: wait ${wait}s.` : 'Incorrect password, or the vault could not be unlocked.')
      setBusy(false)
    }
  }

  const erase = async () => {
    const ok = await confirm({
      title: 'Erase this vault?',
      confirmLabel: 'Erase everything',
      requireText: 'ERASE',
      message: 'This permanently deletes ALL encrypted data stored on this device and lets you start over. It cannot be undone. Only do this if you have an encrypted backup or accept losing the data.',
    })
    if (ok) await vault.destroy()
  }

  return (
    <Shell title="Unlock SpendFlow">
      <form onSubmit={submit} noValidate className="space-y-4">
        <PasswordInput id="unlock-pw" label="Password" value={pw} onChange={setPw} autoComplete="current-password" autoFocus error={error || undefined} />
        <button type="submit" className="btn-primary w-full" disabled={busy}>
          <Lock size={16} /> {busy ? 'Unlocking…' : 'Unlock'}
        </button>
        <button type="button" className="w-full text-center text-xs font-semibold text-subtle underline" onClick={() => setHelp(!help)} aria-expanded={help}>
          Forgot your password?
        </button>
        {help && (
          <div className="rounded-xl bg-muted p-3 text-xs text-subtle">
            <p>Your password can't be recovered or reset: it is the only thing that can decrypt your data. If you have an encrypted backup, erase this vault, set a new password, then restore the backup in Settings.</p>
            <button type="button" className="btn-danger mt-3 !min-h-[34px]" onClick={erase}>Erase vault and start over…</button>
          </div>
        )}
      </form>
    </Shell>
  )
}
