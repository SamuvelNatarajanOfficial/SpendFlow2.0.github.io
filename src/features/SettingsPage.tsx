import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Link, useLocation } from 'react-router-dom'
import { Moon, Pencil, Plus, ShieldCheck, Sun, Trash2 } from 'lucide-react'
import { useData } from '@/app/data'
import { Badge, Field, fp, Modal, Notice, PageHeader, Section, useConfirm, useToast } from '@/components/ui'
import { categories as repo, updateSettings } from '@/db/repo'
import { CATEGORY_COLORS } from '@/db/defaults'
import { formatINR } from '@/lib/money'
import { totalBalance } from '@/lib/calc/ledger'
import type { Category } from '@/types'
import DataSection from './DataSection'
import SecuritySection from './SecuritySection'

const TZS = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'UTC']

const schema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(40, 'Max 40 characters'),
  kind: z.enum(['income', 'expense']),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  essential: z.boolean(),
})
type FV = z.infer<typeof schema>

function CategoryForm({ edit, onClose }: { edit?: Category; onClose: () => void }) {
  const toast = useToast()
  const { register, handleSubmit, watch, setValue, setError, formState: { errors } } = useForm<FV>({
    resolver: zodResolver(schema),
    defaultValues: { name: edit?.name ?? '', kind: edit?.kind ?? 'expense', color: edit?.color ?? CATEGORY_COLORS[0], essential: !!edit?.essential },
  })
  const kind = watch('kind')
  const color = watch('color')
  const submit = handleSubmit(async (v) => {
    try {
      if (edit) await repo.update(edit.id, { name: v.name, color: v.color, essential: v.kind === 'expense' ? v.essential : undefined })
      else await repo.create({ name: v.name, kind: v.kind, color: v.color, essential: v.kind === 'expense' ? v.essential : undefined })
      toast(edit ? 'Category updated' : 'Category added')
      onClose()
    } catch (e) {
      setError('root', { message: e instanceof Error ? e.message : 'Could not save' })
    }
  })
  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field label="Category name" id="c-name" error={errors.name?.message}><input {...fp('c-name', errors.name?.message)} className="input" autoFocus {...register('name')} /></Field>
      {!edit && (
        <Field label="Kind" id="c-kind">
          <select id="c-kind" className="input" {...register('kind')}><option value="expense">Expense</option><option value="income">Income</option></select>
        </Field>
      )}
      <fieldset>
        <legend className="label">Colour</legend>
        <div className="flex flex-wrap gap-2">
          {CATEGORY_COLORS.map((c) => (
            <button key={c} type="button" onClick={() => setValue('color', c)} aria-label={`Colour ${c}`} aria-pressed={color === c} className="h-8 w-8 rounded-full ring-offset-2 ring-offset-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand aria-pressed:ring-2 aria-pressed:ring-fg" style={{ background: c }} />
          ))}
        </div>
      </fieldset>
      {kind === 'expense' && <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" className="h-4 w-4 accent-[rgb(var(--brand))]" {...register('essential')} /> Usually essential spending</label>}
      {errors.root && <p role="alert" className="err">{errors.root.message}</p>}
      <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button type="submit" className="btn-primary">{edit ? 'Save' : 'Add category'}</button></div>
    </form>
  )
}

function Categories() {
  const d = useData()
  const confirm = useConfirm()
  const toast = useToast()
  const [modal, setModal] = useState<{ edit?: Category } | null>(null)
  const del = async (c: Category) => {
    const used = d.transactions.filter((t) => t.categoryId === c.id).length
    if (used) return toast(`"${c.name}" is used by ${used} transaction(s). Re-categorise them first.`, 'error')
    if (await confirm({ title: 'Delete category?', message: `"${c.name}" and any budgets set for it will be deleted.` })) {
      await repo.remove(c.id)
      toast('Category deleted')
    }
  }
  return (
    <Section title="Categories" id="categories" actions={<button type="button" className="btn-secondary !min-h-[36px]" onClick={() => setModal({})}><Plus size={16} /> Add</button>}>
      <div className="grid gap-5 md:grid-cols-2">
        {(['expense', 'income'] as const).map((kind) => (
          <div key={kind}>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-subtle">{kind} categories</h3>
            <ul className="divide-y divide-line">
              {d.categories.filter((c) => c.kind === kind).sort((a, b) => a.name.localeCompare(b.name)).map((c) => (
                <li key={c.id} className="flex items-center gap-2 py-1.5 text-sm">
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: c.color }} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  {c.essential && <Badge>Essential</Badge>}
                  {!c.builtIn && <Badge tone="pos">Custom</Badge>}
                  <button type="button" className="btn-ghost !min-h-[32px] !px-2" aria-label={`Edit category ${c.name}`} onClick={() => setModal({ edit: c })}><Pencil size={14} /></button>
                  <button type="button" className="btn-ghost !min-h-[32px] !px-2 hover:!text-neg" aria-label={`Delete category ${c.name}`} onClick={() => del(c)}><Trash2 size={14} /></button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <Modal open={!!modal} onClose={() => setModal(null)} title={modal?.edit ? 'Edit category' : 'Add category'}>{modal && <CategoryForm edit={modal.edit} onClose={() => setModal(null)} />}</Modal>
    </Section>
  )
}

export default function SettingsPage() {
  const d = useData()
  const { hash } = useLocation()
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth' })
  }, [hash])

  return (
    <div className="space-y-5">
      <PageHeader title="Settings" subtitle="Preferences, categories, data and privacy" />

      <Section title="Appearance & region">
        <div className="grid gap-4 sm:grid-cols-3">
          <fieldset>
            <legend className="label">Theme</legend>
            <div className="inline-flex rounded-xl border border-line p-0.5">
              {(['light', 'dark'] as const).map((t) => (
                <button key={t} type="button" aria-pressed={d.settings.theme === t} onClick={() => updateSettings({ theme: t })} className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-[10px] px-3 text-sm font-semibold capitalize ${d.settings.theme === t ? 'bg-navy text-white dark:bg-brand dark:text-brand-fg' : 'text-subtle'}`}>
                  {t === 'light' ? <Sun size={14} /> : <Moon size={14} />} {t}
                </button>
              ))}
            </div>
          </fieldset>
          <Field label="Currency" id="cur"><select id="cur" className="input" value="INR" disabled aria-describedby="cur-hint"><option>INR (₹)</option></select></Field>
          <Field label="Timezone" id="tz">
            <select id="tz" className="input" value={d.settings.timezone} onChange={(e) => updateSettings({ timezone: e.target.value })}>
              {TZS.map((z) => <option key={z}>{z}</option>)}
            </select>
          </Field>
        </div>
        <p id="cur-hint" className="mt-2 text-xs text-subtle">Amounts are in Indian rupees. The timezone decides what "today" means (default Asia/Kolkata).</p>
      </Section>

      <Section title="Accounts" actions={<Link to="/accounts" className="text-sm font-semibold text-brand">Manage accounts</Link>}>
        <ul className="divide-y divide-line text-sm">
          {d.accounts.length === 0 && <li className="py-2 text-subtle">No accounts yet.</li>}
          {d.accounts.map((a) => <li key={a.id} className="flex justify-between py-2"><span>{a.name} {a.archived && <Badge>Archived</Badge>}</span><span className="num text-subtle">{a.type}</span></li>)}
        </ul>
        <p className="num mt-2 text-xs text-subtle">Total calculated balance {formatINR(totalBalance(d.accounts, d.transactions))}</p>
      </Section>

      <SecuritySection />
      <Categories />
      <DataSection />

      <Section title="Privacy & security" actions={<ShieldCheck size={18} className="text-pos" />}>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-subtle">
          <li>All data stays in <strong>this browser</strong> (IndexedDB), <strong>encrypted</strong> with AES-256-GCM using a key derived from your password. Nothing is sent to any server, analytics or API.</li>
          <li>Encryption protects data <strong>while locked</strong>. While the app is unlocked, the decrypted data is in memory and anyone using your unlocked session, or malicious code running in this page or a browser extension, can read it. Lock when you step away.</li>
          <li>Clearing site data, private browsing or uninstalling the browser can <strong>erase your records</strong>. Back up regularly.</li>
          <li>SpendFlow never asks for bank credentials, UPI PINs, OTPs or card details, and does not connect to bank accounts. Don't store them in notes.</li>
        </ul>
        <Notice>Your password cannot be recovered. Keep an encrypted backup and remember its password. See docs/SECURITY.md for the full threat model.</Notice>
      </Section>
    </div>
  )
}
