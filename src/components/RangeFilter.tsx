import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { isValidDate, rangeFor, type RangePreset } from '@/lib/dates'
import { useData } from '@/app/data'
import type { DateRange } from '@/types'

const PRESETS: { id: RangePreset; label: string }[] = [
  { id: 'this-month', label: 'This month' },
  { id: 'last-month', label: 'Last month' },
  { id: 'this-year', label: 'This year' },
  { id: 'custom', label: 'Custom' },
]

export function useRange(initial: RangePreset = 'this-month') {
  const { today } = useData()
  const [preset, setPreset] = useState<RangePreset>(initial)
  const [custom, setCustom] = useState<{ from: string; to: string }>(() => {
    const r = rangeFor('this-month', today)
    return { from: r.from, to: r.to }
  })
  const range: DateRange = useMemo(() => rangeFor(preset, today, custom), [preset, today, custom])
  return { preset, setPreset, custom, setCustom, range }
}

export function RangeFilter({ r }: { r: ReturnType<typeof useRange> }) {
  const invalid = r.preset === 'custom' && (!isValidDate(r.custom.from) || !isValidDate(r.custom.to))
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Date range">
      <div className="inline-flex rounded-xl border border-line bg-card p-0.5">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={r.preset === p.id}
            onClick={() => r.setPreset(p.id)}
            className={clsx('min-h-[36px] rounded-[10px] px-3 text-xs font-semibold transition-colors', r.preset === p.id ? 'bg-navy text-white dark:bg-brand dark:text-brand-fg' : 'text-subtle hover:text-fg')}
          >
            {p.label}
          </button>
        ))}
      </div>
      {r.preset === 'custom' && (
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="rf-from">From date</label>
          <input id="rf-from" type="date" className="input !min-h-[36px] !w-auto" value={r.custom.from} onChange={(e) => r.setCustom({ ...r.custom, from: e.target.value })} />
          <span className="text-subtle">to</span>
          <label className="sr-only" htmlFor="rf-to">To date</label>
          <input id="rf-to" type="date" className="input !min-h-[36px] !w-auto" value={r.custom.to} onChange={(e) => r.setCustom({ ...r.custom, to: e.target.value })} />
          {invalid && <span className="err">Pick valid dates</span>}
        </div>
      )}
    </div>
  )
}
