import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import clsx from 'clsx'

// ---------- Modal (native <dialog>: focus trap, Esc, inert background for free) ----------

export function Modal({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose()
      }}
      className="m-auto w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-card p-0 text-fg shadow-2xl backdrop:bg-black/50 max-sm:mb-0 max-sm:max-w-none max-sm:rounded-b-none"
    >
      {open && (
        <div className="flex max-h-[92dvh] flex-col">
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <h2 className="text-base font-bold">{title}</h2>
            <button type="button" className="btn-ghost !min-h-[36px] !px-2" onClick={onClose} aria-label="Close dialog">
              <X size={18} />
            </button>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  )
}

// ---------- Confirm ----------

interface ConfirmOpts {
  title: string
  message: ReactNode
  confirmLabel?: string
  /** user must type this exact text to enable the button (strong confirmation) */
  requireText?: string
  danger?: boolean
}
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false)
export const useConfirm = () => useContext(ConfirmCtx)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ opts: ConfirmOpts; resolve: (v: boolean) => void } | null>(null)
  const [typed, setTyped] = useState('')
  const confirm = useCallback((opts: ConfirmOpts) => new Promise<boolean>((resolve) => { setTyped(''); setState({ opts, resolve }) }), [])
  const close = (v: boolean) => {
    state?.resolve(v)
    setState(null)
  }
  const o = state?.opts
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Modal
        open={!!state}
        onClose={() => close(false)}
        title={o?.title ?? ''}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => close(false)}>Cancel</button>
            <button type="button" className={o?.danger === false ? 'btn-primary' : 'btn-danger'} disabled={!!o?.requireText && typed !== o.requireText} onClick={() => close(true)}>
              {o?.confirmLabel ?? 'Delete'}
            </button>
          </>
        }
      >
        <div className="text-sm text-subtle">{o?.message}</div>
        {o?.requireText && (
          <div className="mt-4">
            <label htmlFor="confirm-text" className="label">Type {o.requireText} to confirm</label>
            <input id="confirm-text" className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </div>
        )}
      </Modal>
    </ConfirmCtx.Provider>
  )
}

// ---------- Toasts ----------

type ToastKind = 'success' | 'error' | 'info'
const ToastCtx = createContext<(msg: string, kind?: ToastKind) => void>(() => undefined)
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; msg: string; kind: ToastKind }[]>([])
  const idRef = useRef(0)
  const push = useCallback((msg: string, kind: ToastKind = 'success') => {
    const id = ++idRef.current
    setItems((s) => [...s, { id, msg, kind }])
    setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[100] flex flex-col items-center gap-2 px-4 md:bottom-6" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={clsx('pointer-events-auto flex max-w-md items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium text-white shadow-lg', t.kind === 'error' ? 'bg-neg' : 'bg-navy dark:bg-muted dark:text-fg')}>
            {t.kind === 'error' ? <AlertTriangle size={16} /> : t.kind === 'info' ? <Info size={16} /> : <CheckCircle2 size={16} />}
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

// ---------- Small building blocks ----------

export function Field({ label, id, error, hint, children }: { label: string; id: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="label">{label}</label>
      {children}
      {hint && !error && <p id={`${id}-hint`} className="mt-1 text-xs text-subtle">{hint}</p>}
      {error && <p id={`${id}-err`} role="alert" className="err">{error}</p>}
    </div>
  )
}
/** aria attributes for an input wired to Field */
export const fp = (id: string, error?: string, hint?: string) => ({
  id,
  'aria-invalid': error ? (true as const) : undefined,
  'aria-describedby': error ? `${id}-err` : hint ? `${id}-hint` : undefined,
})

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-subtle">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

export function Stat({ label, value, sub, tone, icon }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'pos' | 'neg' | 'warn'; icon?: ReactNode }) {
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-subtle">
        <span>{label}</span>
        {icon}
      </div>
      <div className={clsx('num mt-1 text-2xl font-bold', tone === 'pos' && 'text-pos', tone === 'neg' && 'text-neg', tone === 'warn' && 'text-warn')}>{value}</div>
      {sub && <div className="mt-1 text-xs text-subtle">{sub}</div>}
    </div>
  )
}

export function EmptyState({ icon, title, text, action }: { icon?: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-line px-6 py-10 text-center">
      {icon && <div className="mb-3 text-subtle">{icon}</div>}
      <p className="font-semibold">{title}</p>
      {text && <p className="mt-1 max-w-sm text-sm text-subtle">{text}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function ProgressBar({ value, tone = 'brand', label }: { value: number; tone?: 'brand' | 'warn' | 'neg'; label: string }) {
  const v = Math.max(0, Math.min(100, value))
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={label} aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}>
      <div className={clsx('h-full rounded-full transition-[width]', tone === 'brand' && 'bg-brand', tone === 'warn' && 'bg-warn', tone === 'neg' && 'bg-neg')} style={{ width: `${v}%` }} />
    </div>
  )
}

export function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'pos' | 'neg' | 'warn' }) {
  return (
    <span className={clsx('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold', tone === 'muted' && 'bg-muted text-subtle', tone === 'pos' && 'bg-pos/15 text-pos', tone === 'neg' && 'bg-neg/15 text-neg', tone === 'warn' && 'bg-warn/15 text-warn')}>
      {children}
    </span>
  )
}

export function Notice({ tone = 'info', children, action }: { tone?: 'info' | 'warn' | 'neg'; children: ReactNode; action?: ReactNode }) {
  return (
    <div role={tone === 'info' ? 'note' : 'alert'} className={clsx('flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 text-sm', tone === 'info' && 'border-line bg-muted text-fg', tone === 'warn' && 'border-warn/40 bg-warn/10 text-fg', tone === 'neg' && 'border-neg/40 bg-neg/10 text-fg')}>
      {tone === 'info' ? <Info size={16} className="shrink-0" /> : <AlertTriangle size={16} className="shrink-0" />}
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  )
}

export function Section({ title, actions, children, id }: { title: string; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="card p-4 md:p-5" aria-labelledby={id ? `${id}-h` : undefined} id={id}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id={id ? `${id}-h` : undefined} className="text-base font-bold">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  )
}
