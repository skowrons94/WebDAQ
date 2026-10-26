'use client'

import { ChevronDown, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'

export const emptyQuery = { runs: '', flag: '', exclude: '', date_from: '', date_to: '', voltage_min: '', voltage_max: '' }

type Props = {
  target: string; runType: string; targets: string[]; runTypes: string[]
  fields: Record<string,string>; onTarget: (value: string) => void; onType: (value: string) => void
  onField: (key: string, value: string) => void; onReset: () => void; onApply: () => void
  count: number; pending: boolean; error: string; active: boolean
}
function Choice({ label, value, options, all, onChange }: { label: string; value: string; options: string[]; all: string; onChange: (value: string) => void }) {
  return <div className="space-y-1.5"><span className="text-xs font-medium text-muted-foreground">{label}</span>
    <Select value={value || '__all__'} onValueChange={v => onChange(v === '__all__' ? '' : v)}>
      <SelectTrigger aria-label={`Query ${label.toLowerCase()}`} className="h-9 text-xs"><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value="__all__">{all}</SelectItem>{options.map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}</SelectContent>
    </Select></div>
}
export function RunQuery(p: Props) {
  const selectionCount = ['runs','exclude','flag'].filter(k => p.fields[k]).length
  const advancedCount = ['date_from','date_to','voltage_min','voltage_max'].filter(k => p.fields[k]).length
  const field = (key: string, label: string, type = 'text', placeholder?: string) => <label className="block min-w-0 space-y-1.5 text-xs font-medium text-muted-foreground">{label}<Input className="h-9 min-w-0 text-xs" aria-label={label} type={type} step={type === 'number' ? 'any' : undefined} value={p.fields[key] || ''} placeholder={placeholder} onChange={e => p.onField(key,e.target.value)} /></label>
  return <section aria-label="Run query" className="rounded-lg border bg-muted/20 overflow-hidden">
    <div className="flex h-10 items-center justify-between border-b px-3"><h3 className="flex items-center gap-2 text-xs font-semibold"><SlidersHorizontal size={14} />Run filters</h3><Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={!p.active} onClick={p.onReset}>Reset</Button></div>
    <div className="space-y-3 p-3">
      <Choice label="Target" value={p.target} options={p.targets} all="All targets" onChange={p.onTarget} />
      <Choice label="Run type" value={p.runType} options={p.runTypes} all="All types" onChange={p.onType} />
      <details className="group border-t pt-3"><summary className="flex cursor-pointer list-none items-center justify-between text-xs font-medium [&::-webkit-details-marker]:hidden">Run numbers & flags {selectionCount > 0 && <span className="ml-auto mr-2 rounded bg-primary/10 px-1.5 text-primary">{selectionCount}</span>}<ChevronDown size={14} className="transition-transform group-open:rotate-180" /></summary><div className="space-y-3 pt-3">
      <Choice label="Flag" value={p.fields.flag} options={['good','bad','unknown']} all="Any flag" onChange={v => p.onField('flag',v)} />
      {field('runs','Include runs','text','e.g. 101-107, 112')}
      {field('exclude','Exclude runs','text','e.g. 104, 109-111')}
      </div></details>
      <details className="group border-t pt-3"><summary className="flex cursor-pointer list-none items-center justify-between text-xs font-medium [&::-webkit-details-marker]:hidden">Date & voltage {advancedCount > 0 && <span className="ml-auto mr-2 rounded bg-primary/10 px-1.5 text-primary">{advancedCount}</span>}<ChevronDown size={14} className="transition-transform group-open:rotate-180" /></summary>
        <div className="space-y-3 pt-3">
          <fieldset className="space-y-2"><legend className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">Run start date</legend>{field('date_from','From date','date')}{field('date_to','Through date','date')}</fieldset>
          <fieldset className="space-y-2"><legend className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">Terminal voltage (kV)</legend><div className="grid grid-cols-2 gap-2">{field('voltage_min','Minimum kV','number','Min')}{field('voltage_max','Maximum kV','number','Max')}</div></fieldset>
        </div>
      </details>
    </div>
    <div className="space-y-2 border-t bg-background/50 p-3">
      <p role="status" className={`text-xs ${p.error ? 'text-destructive' : 'text-muted-foreground'}`}>{p.pending ? 'Matching runs…' : p.error || `${p.count} completed ${p.count === 1 ? 'run' : 'runs'} matched`}</p>
      <Button size="sm" variant="outline" className="w-full text-xs" disabled={!p.active || p.pending || !!p.error || !p.count || p.count > 100} onClick={p.onApply}>Apply query to Load Run(s)</Button>
      {p.count > 100 && <p className="text-xs text-muted-foreground">Narrow the query to 100 runs or fewer.</p>}
    </div>
  </section>
}
