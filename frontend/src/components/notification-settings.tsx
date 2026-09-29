'use client'

import { useEffect, useState } from 'react'
import {
  Bell, CheckCircle, Loader2, Plug, Plus, Trash2, XCircle,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'
import { useToast } from '@/components/ui/use-toast'
import {
  addAlertRule, deleteAlertRule, getAlertRules, getNotificationTransports,
  setAlertWatcher, setNotificationSettings, setTelegramTransport, setZulipTransport,
  testNotificationTransport, updateAlertRule,
  type AlertRule, type AlertRuleType, type AlertStatus, type TransportSettings,
} from '@/lib/api'

/**
 * Settings → Notifications.
 *
 * Two halves: where messages can go (Telegram, Zulip) and what is worth sending
 * one (the alert rules). A rule names its own destinations, so a board failure
 * can wake the whole shift on Zulip while a beam-current dip only goes to the
 * Telegram group.
 */

type TestResult = { success: boolean; message: string }

const COMPARISONS = [
  { value: 'below', label: 'below' },
  { value: 'above', label: 'above' },
]

export function NotificationSettings() {
  const { toast } = useToast()

  const [telegram, setTelegram] = useState<TransportSettings | null>(null)
  const [zulip, setZulip] = useState<TransportSettings | null>(null)
  const [rules, setRules] = useState<AlertRule[]>([])
  const [types, setTypes] = useState<AlertRuleType[]>([])
  const [status, setStatus] = useState<AlertStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, TestResult | null>>({})

  // Telegram fields
  const [botToken, setBotToken] = useState('')
  const [chatId, setChatId] = useState('')
  // Zulip fields
  const [site, setSite] = useState('')
  const [botEmail, setBotEmail] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [stream, setStream] = useState('')
  const [topic, setTopic] = useState('')

  const [newRuleType, setNewRuleType] = useState<AlertRule['type']>('graphite_metric')

  useEffect(() => { refresh(true) }, [])

  async function refresh(initial = false) {
    try {
      if (initial) setLoading(true)
      const [transports, ruleData] = await Promise.all([
        getNotificationTransports(), getAlertRules(),
      ])
      setTelegram(transports.telegram)
      setZulip(transports.zulip)
      setChatId(transports.telegram.chat_id ?? '')
      setSite(transports.zulip.site ?? '')
      setBotEmail(transports.zulip.bot_email ?? '')
      setStream(transports.zulip.stream ?? '')
      setTopic(transports.zulip.topic ?? '')
      // Secrets arrive masked; leave the inputs empty so saving keeps them.
      setBotToken('')
      setApiKey('')
      setRules(ruleData.rules)
      setTypes(ruleData.types)
      setStatus(ruleData.status)
    } catch (error) {
      console.error('Failed to load notification settings:', error)
      toast({ title: 'Error', description: 'Failed to load the notification settings',
              variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  async function act(key: string, work: () => Promise<unknown>, success?: string) {
    try {
      setBusy(key)
      await work()
      await refresh()
      if (success) toast({ title: success })
    } catch (error: unknown) {
      const message = (error as { response?: { data?: { error?: string } } })
        ?.response?.data?.error
      toast({ title: 'Error', description: message ?? 'The change was not saved',
              variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  async function test(transport: 'telegram' | 'zulip') {
    try {
      setBusy(`test-${transport}`)
      const result = await testNotificationTransport(transport)
      setTestResult((r) => ({ ...r, [transport]: result }))
    } catch {
      setTestResult((r) => ({
        ...r,
        [transport]: { success: false, message: 'The WebDAQ server could not be reached.' },
      }))
    } finally {
      setBusy(null)
    }
  }

  function ruleStatus(id: string) {
    return status?.rules.find((r) => r.id === id)
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      {/* ── Where messages go ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Telegram</CardTitle>
          <CardDescription>
            A bot posts to one chat or group. Talk to @BotFather to create the bot, then
            add it to the group that should receive the alerts.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Switch
              checked={telegram?.enabled ?? false}
              disabled={!telegram?.configured || busy !== null}
              onCheckedChange={(checked) => act('telegram-enabled',
                () => setTelegramTransport({ enabled: checked }))}
            />
            <Label>Send messages to Telegram</Label>
            {telegram?.configured
              ? <Badge variant="secondary">Configured</Badge>
              : <Badge variant="outline">Not configured</Badge>}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="tg-token">Bot token</Label>
              <Input id="tg-token" type="password" value={botToken}
                     onChange={(e) => setBotToken(e.target.value)}
                     placeholder={telegram?.bot_token ? 'Unchanged' : 'Not set'} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tg-chat">Chat ID</Label>
              <Input id="tg-chat" value={chatId} onChange={(e) => setChatId(e.target.value)}
                     placeholder="-1001234567890" />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={busy !== null}
                    onClick={() => act('telegram-save',
                      () => setTelegramTransport({ bot_token: botToken, chat_id: chatId }),
                      'Telegram settings saved')}>
              Save
            </Button>
            <Button variant="outline" disabled={busy !== null || !telegram?.configured}
                    onClick={() => test('telegram')}>
              {busy === 'test-telegram'
                ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                : <Plug className="mr-1.5 h-4 w-4" />}
              Test message
            </Button>
            <Result result={testResult.telegram} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Zulip</CardTitle>
          <CardDescription>
            A bot posts every alert to one stream and topic, so they stay together in a
            thread the shift can read and reply to.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Switch
              checked={zulip?.enabled ?? false}
              disabled={!zulip?.configured || busy !== null}
              onCheckedChange={(checked) => act('zulip-enabled',
                () => setZulipTransport({ enabled: checked }))}
            />
            <Label>Send messages to Zulip</Label>
            {zulip?.configured
              ? <Badge variant="secondary">Configured</Badge>
              : <Badge variant="outline">Not configured</Badge>}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="zulip-site">Organisation URL</Label>
              <Input id="zulip-site" value={site} onChange={(e) => setSite(e.target.value)}
                     placeholder="https://chat.example.org" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="zulip-email">Bot email</Label>
              <Input id="zulip-email" value={botEmail}
                     onChange={(e) => setBotEmail(e.target.value)}
                     placeholder="webdaq-bot@chat.example.org" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="zulip-key">Bot API key</Label>
              <Input id="zulip-key" type="password" value={apiKey}
                     onChange={(e) => setApiKey(e.target.value)}
                     placeholder={zulip?.api_key ? 'Unchanged' : 'Not set'} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="zulip-stream">Stream</Label>
              <Input id="zulip-stream" value={stream}
                     onChange={(e) => setStream(e.target.value)} placeholder="LUNA DAQ" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="zulip-topic">Topic</Label>
              <Input id="zulip-topic" value={topic} onChange={(e) => setTopic(e.target.value)}
                     placeholder="WebDAQ alerts" />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={busy !== null}
                    onClick={() => act('zulip-save', () => setZulipTransport({
                      site, bot_email: botEmail, api_key: apiKey, stream, topic,
                    }), 'Zulip settings saved')}>
              Save
            </Button>
            <Button variant="outline" disabled={busy !== null || !zulip?.configured}
                    onClick={() => test('zulip')}>
              {busy === 'test-zulip'
                ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                : <Plug className="mr-1.5 h-4 w-4" />}
              Test message
            </Button>
            <Result result={testResult.zulip} />
          </div>
        </CardContent>
      </Card>

      {/* ── What is worth a message ───────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Bell className="h-4 w-4" />
                Alerts
              </CardTitle>
              <CardDescription>
                Each alert fires once when its condition starts and stays quiet until it
                clears again. Pick which destinations carry it.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={status?.watching ? 'default' : 'destructive'}>
                {status?.watching ? 'Watching' : 'Not watching'}
              </Badge>
              {!status?.watching && (
                <Button size="sm" variant="outline" disabled={busy !== null}
                        onClick={() => act('watcher', () => setAlertWatcher('start'),
                                          'Watching for alerts')}>
                  Start watching
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Switch checked={status?.notify_recovery ?? true} disabled={busy !== null}
                    onCheckedChange={(checked) => act('recovery',
                      () => setNotificationSettings({ notify_recovery: checked }))} />
            <Label>Also send a message when a condition clears</Label>
          </div>

          {status?.load_error && (
            <p className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm">
              {status.load_error}
            </p>
          )}

          {(status?.rejected_rules?.length ?? 0) > 0 && (
            <div className="rounded-md border border-amber-500/60 bg-amber-500/5 p-3 text-sm">
              <p className="font-medium">
                {status!.rejected_rules!.length} saved alert
                {status!.rejected_rules!.length === 1 ? '' : 's'} could not be read, and
                {status!.rejected_rules!.length === 1 ? ' is' : ' are'} not being watched:
              </p>
              <ul className="mt-1 list-inside list-disc text-xs text-muted-foreground">
                {status!.rejected_rules!.map((rejected, i) => (
                  <li key={i}>{rejected.reason}</li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-muted-foreground">
                They are still in conf/alerts.json — fix them there, or add them again here.
              </p>
            </div>
          )}

          {!status?.watching && (
            <p className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm">
              Nothing is being watched, so no alert can be raised — whatever the rules
              below say. This normally means the server was started without its
              watcher; press <span className="font-medium">Start watching</span> above.
            </p>
          )}

          {rules.length === 0 && (
            <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              No alerts yet. Nothing will be sent, whatever happens during a run.
            </p>
          )}

          <div className="space-y-3">
            {rules.map((rule) => (
              <RuleCard key={rule.id} rule={rule} busy={busy !== null}
                        alerting={ruleStatus(rule.id)?.alerting ?? false}
                        notReady={ruleStatus(rule.id)?.transports_not_ready ?? []}
                        unmeasured={ruleStatus(rule.id)?.unmeasured ?? false}
                        unmeasuredFor={ruleStatus(rule.id)?.unmeasured_for ?? null}
                        onChange={(changes) => act(`rule-${rule.id}`,
                          () => updateAlertRule(rule.id, changes))}
                        onDelete={() => act(`delete-${rule.id}`,
                          () => deleteAlertRule(rule.id), 'Alert removed')} />
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t pt-4">
            <Select value={newRuleType}
                    onValueChange={(value) => setNewRuleType(value as AlertRule['type'])}>
              <SelectTrigger className="w-72"><SelectValue /></SelectTrigger>
              <SelectContent>
                {types.map((type) => (
                  <SelectItem key={type.type} value={type.type}>{type.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" disabled={busy !== null}
                    onClick={() => act('add', () => addAlertRule({
                      type: newRuleType, transports: ['telegram'],
                      params: newRuleType === 'graphite_metric'
                        ? { metric: 'ancillary.rates.bo_0.writeRate' } : {},
                    }), 'Alert added')}>
              <Plus className="mr-1.5 h-4 w-4" />
              Add alert
            </Button>
            <p className="text-xs text-muted-foreground">
              {types.find((t) => t.type === newRuleType)?.description}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * A number the server owns: shows the stored value, lets it be typed, and never
 * writes an empty box as 0 — a threshold of zero is an alert that never fires or
 * never stops.
 */
function NumberField({ value, draft, setDraft, field, onCommit, min, step }: {
  value: number
  draft: string | undefined
  setDraft: React.Dispatch<React.SetStateAction<Record<string, string | undefined>>>
  field: string
  onCommit: (value: number) => void
  min?: number
  step?: string
}) {
  return (
    <Input
      type="number"
      min={min}
      step={step}
      value={draft ?? String(value)}
      onChange={(e) => setDraft((d) => ({ ...d, [field]: e.target.value }))}
      onBlur={(e) => {
        const text = e.target.value.trim()
        setDraft((d) => ({ ...d, [field]: undefined }))
        const parsed = Number(text)
        // An empty or unreadable box means "leave it alone", not zero.
        if (text === '' || Number.isNaN(parsed) || parsed === value) return
        onCommit(parsed)
      }}
    />
  )
}

function Result({ result }: { result?: TestResult | null }) {
  if (!result) return null
  return (
    <span className={`flex items-center gap-1.5 text-sm ${
      result.success ? 'text-green-600 dark:text-green-400' : 'text-destructive'}`}>
      {result.success ? <CheckCircle className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
      {result.message}
    </span>
  )
}

function RuleCard({ rule, alerting, notReady, unmeasured, unmeasuredFor, busy,
                   onChange, onDelete }: {
  rule: AlertRule
  alerting: boolean
  notReady: string[]
  unmeasured: boolean
  unmeasuredFor: number | null
  busy: boolean
  onChange: (changes: Partial<AlertRule>) => void
  onDelete: () => void
}) {
  const params = rule.params
  const transports = rule.transports
  // While a field is being typed in, the draft wins; once it is committed the
  // server's own value (which it may have clamped) is what shows.
  const [draft, setDraft] = useState<Record<string, string | undefined>>({})

  const toggleTransport = (name: string, on: boolean) => {
    const next = on ? [...transports, name] : transports.filter((t) => t !== name)
    onChange({ transports: next })
  }

  // Each rule type shows only the fields it has.
  const hasThreshold = 'threshold' in params
  const hasSeconds = 'seconds' in params
  const hasMetric = 'metric' in params
  const hasPoll = 'poll_seconds' in params
  const hasRunOnly = 'during_run_only' in params

  return (
    <div className={`rounded-lg border p-4 ${alerting ? 'border-destructive' : ''}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Switch checked={rule.enabled} disabled={busy}
                  onCheckedChange={(checked) => onChange({ enabled: checked })} />
          <div>
            <p className="font-medium">{rule.name}</p>
            <p className="text-xs text-muted-foreground">{rule.type}</p>
          </div>
          {alerting && <Badge variant="destructive">Alerting now</Badge>}
          {rule.enabled && unmeasured && !alerting && (
            <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
                   title="This alert is watching, but it has had nothing to read — an unreachable Graphite server, a monitor that stopped, or a counter this CaenDAQ build does not report. That is not the same as everything being fine.">
              nothing to measure{unmeasuredFor ? ` for ${unmeasuredFor} s` : ''}
            </Badge>
          )}
          {rule.enabled && notReady.length === rule.transports.length && (
            <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
                   title={rule.transports.length
                     ? `${notReady.join(' and ')} ${notReady.length === 1 ? 'is' : 'are'} off or not configured`
                     : 'This alert has no destination'}>
              reaches nobody
            </Badge>
          )}
        </div>
        <Button variant="ghost" size="sm" className="text-destructive" disabled={busy}
                onClick={onDelete}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {hasMetric && (
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
            <Label className="text-xs">Graphite metric</Label>
            <Input value={draft.metric ?? String(params.metric ?? '')}
                   placeholder="luna.terminal_voltage"
                   onChange={(e) => setDraft((d) => ({ ...d, metric: e.target.value }))}
                   onBlur={(e) => {
                     const value = e.target.value.trim()
                     setDraft((d) => ({ ...d, metric: undefined }))
                     if (value && value !== params.metric) {
                       onChange({ params: { ...params, metric: value } })
                     }
                   }} />
          </div>
        )}
        {hasThreshold && (
          <>
            <div className="space-y-1.5">
              <Label className="text-xs">Alert when the value is</Label>
              <Select value={String(params.comparison ?? 'below')}
                      onValueChange={(value) =>
                        onChange({ params: { ...params, comparison: value } })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COMPARISONS.map((c) => (
                    <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Threshold</Label>
              <NumberField value={Number(params.threshold ?? 0)} step="any"
                           draft={draft.threshold} setDraft={setDraft} field="threshold"
                           onCommit={(value) =>
                             onChange({ params: { ...params, threshold: value } })} />
            </div>
          </>
        )}
        {hasSeconds && (
          <div className="space-y-1.5">
            <Label className="text-xs">
              {rule.type === 'stalled_buffers' ? 'No data for (s)' : 'Held for (s)'}
            </Label>
            <NumberField value={Number(params.seconds ?? 0)} min={0}
                         draft={draft.seconds} setDraft={setDraft} field="seconds"
                         onCommit={(value) =>
                           onChange({ params: { ...params, seconds: value } })} />
          </div>
        )}
        {hasPoll && (
          <div className="space-y-1.5">
            <Label className="text-xs">Check every (s)</Label>
            <NumberField value={Number(params.poll_seconds ?? 30)} min={5}
                         draft={draft.poll_seconds} setDraft={setDraft} field="poll_seconds"
                         onCommit={(value) =>
                           onChange({ params: { ...params, poll_seconds: value } })} />
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-6 border-t pt-3">
        <div className="flex items-center gap-4">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Send to</span>
          {(['telegram', 'zulip'] as const).map((name) => (
            <label key={name} className="flex items-center gap-2 text-sm capitalize">
              <Switch checked={transports.includes(name)} disabled={busy}
                      onCheckedChange={(checked) => toggleTransport(name, checked)} />
              {name}
            </label>
          ))}
        </div>
        {hasRunOnly && (
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={Boolean(params.during_run_only)} disabled={busy}
                    onCheckedChange={(checked) =>
                      onChange({ params: { ...params, during_run_only: checked } })} />
            Only during a run
          </label>
        )}
      </div>
    </div>
  )
}
