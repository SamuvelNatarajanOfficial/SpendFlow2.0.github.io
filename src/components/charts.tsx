import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useData } from '@/app/data'
import { formatINR, formatINRCompact } from '@/lib/money'
import { formatMonth } from '@/lib/dates'
import type { MonthPoint } from '@/lib/calc/reports'
import type { CategoryTotal } from '@/lib/calc/ledger'

/** Semantic chart colours. Income/expense are always paired with legend text, never colour alone. */
export function useChartColors() {
  const dark = useData().settings.theme === 'dark'
  return {
    income: dark ? '#4ade80' : '#15803d',
    expense: dark ? '#fb7185' : '#e11d48',
    savings: dark ? '#60a5fa' : '#2563eb',
    debt: dark ? '#fbbf24' : '#b45309',
    grid: dark ? '#25385a' : '#dfe4ee',
    axis: dark ? '#99a9c1' : '#5c6a80',
    surface: dark ? '#0e1d34' : '#ffffff',
  }
}

const tipStyle = { borderRadius: 12, border: '1px solid rgb(var(--line))', background: 'rgb(var(--card))', color: 'rgb(var(--fg))', fontSize: 12 }

export function IncomeExpenseChart({ data }: { data: MonthPoint[] }) {
  const c = useChartColors()
  const rows = data.map((d) => ({ ...d, label: formatMonth(d.month) }))
  return (
    <div className="h-64 w-full" role="img" aria-label="Monthly income versus expense bar chart">
      <ResponsiveContainer>
        <BarChart data={rows} barGap={2} margin={{ left: 0, right: 8, top: 8 }}>
          <CartesianGrid stroke={c.grid} vertical={false} />
          <XAxis dataKey="label" tick={{ fill: c.axis, fontSize: 11 }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fill: c.axis, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => formatINRCompact(v)} width={52} />
          <Tooltip contentStyle={tipStyle} formatter={(v) => formatINR(Number(v))} cursor={{ fill: 'rgba(120,130,150,0.12)' }} />
          <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
          <Bar isAnimationActive={false} dataKey="income" name="Income" fill={c.income} radius={[4, 4, 0, 0]} maxBarSize={22} />
          <Bar isAnimationActive={false} dataKey="expense" name="Expense" fill={c.expense} radius={[4, 4, 0, 0]} maxBarSize={22} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

export function SavingsRateChart({ data }: { data: MonthPoint[] }) {
  const c = useChartColors()
  const rows = data.map((d) => ({ label: formatMonth(d.month), rate: d.rate === null ? null : Math.round(d.rate * 10) / 10 }))
  return (
    <div className="h-52 w-full" role="img" aria-label="Savings rate trend line chart">
      <ResponsiveContainer>
        <LineChart data={rows} margin={{ left: 0, right: 8, top: 8 }}>
          <CartesianGrid stroke={c.grid} vertical={false} />
          <XAxis dataKey="label" tick={{ fill: c.axis, fontSize: 11 }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fill: c.axis, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}%`} width={44} />
          <Tooltip contentStyle={tipStyle} formatter={(v) => `${v}%`} />
          <Line isAnimationActive={false} type="monotone" dataKey="rate" name="Savings rate" stroke={c.savings} strokeWidth={2} dot={{ r: 4, stroke: c.surface, strokeWidth: 2 }} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

export function CategoryDonut({ data }: { data: CategoryTotal[] }) {
  const c = useChartColors()
  const total = data.reduce((s, d) => s + d.amount, 0)
  const top = data.slice(0, 7)
  const rest = data.slice(7).reduce((s, d) => s + d.amount, 0)
  const slices = rest > 0 ? [...top, { categoryId: '__other', name: 'Other', color: '#94a3b8', amount: rest }] : top
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row">
      <div className="shrink-0" role="img" aria-label="Expense breakdown by category donut chart">
          <PieChart width={176} height={176}>
            <Pie isAnimationActive={false} data={slices} dataKey="amount" nameKey="name" innerRadius="62%" outerRadius="100%" stroke={c.surface} strokeWidth={2} paddingAngle={0}>
              {slices.map((s) => <Cell key={s.categoryId} fill={s.color} />)}
            </Pie>
            <Tooltip contentStyle={tipStyle} formatter={(v) => formatINR(Number(v))} />
          </PieChart>
      </div>
      {/* legend doubles as the data table so identity never depends on colour alone */}
      <ul className="w-full min-w-0 flex-1 space-y-1.5 text-sm">
        {slices.map((s) => (
          <li key={s.categoryId} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden />
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            <span className="num text-subtle">{total ? Math.round((s.amount / total) * 100) : 0}%</span>
            <span className="num w-24 text-right font-medium">{formatINR(s.amount)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function BalanceTrendChart({ data, label = 'Outstanding' }: { data: { label: string; balance: number; plan?: number }[]; label?: string }) {
  const c = useChartColors()
  const hasPlan = data.some((d) => d.plan !== undefined)
  return (
    <div className="h-56 w-full" role="img" aria-label={`${label} balance over time area chart`}>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
          <CartesianGrid stroke={c.grid} vertical={false} />
          <XAxis dataKey="label" tick={{ fill: c.axis, fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={24} />
          <YAxis tick={{ fill: c.axis, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => formatINRCompact(v)} width={56} />
          <Tooltip contentStyle={tipStyle} formatter={(v) => formatINR(Number(v))} />
          {hasPlan && <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />}
          <Area isAnimationActive={false} type="monotone" dataKey="balance" name={hasPlan ? 'Current EMI' : label} stroke={c.debt} fill={c.debt} fillOpacity={0.18} strokeWidth={2} />
          {hasPlan && <Area isAnimationActive={false} type="monotone" dataKey="plan" name="With plan" stroke={c.income} fill={c.income} fillOpacity={0.12} strokeWidth={2} />}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
