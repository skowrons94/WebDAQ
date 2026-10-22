'use client'

/**
 * The monitoring servers, in one place: the Graphite server everything writes
 * to and reads from (DAQ rates, beam current, Stats page, monitored values) and
 * the Grafana whose alert rules the Alerts page manages. "Detect" looks for
 * both on the hosts WebDAQ knows about, so nobody has to guess a port.
 */

import { useEffect, useState } from 'react'
import { CheckCircle, Loader2, Plug, Radar, XCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ConfirmAction } from '@/components/ui/confirm-action'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { StatusBadge } from '@/components/ui/status-badge'
import { useToast } from '@/components/ui/use-toast'
import { useRunStatus } from '@/hooks/use-run-status'
import {
  detectMonitoringServers, getCurrentGraphiteConfig, getGrafanaSettings, getMonitoringStatus,
  getStatsGraphiteConfig, setGrafanaSettings, setStatsGraphiteConfig, testGrafanaConnection,
  type CurrentGraphiteTarget, type DetectedGrafana, type DetectedGraphite,
  type MonitoringDetection, type MonitoringStatus,
} from '@/lib/api'

// Remembered per browser: the note about where the beam current used to go
// is news once, not on every visit.
const LEGACY_NOTE_KEY = 'webdaq.monitoring.legacyCurrentNoteDismissed'

/**
 * Grafana answers /api/health without a login, so "reachable" alone said
 * nothing about the Alerts page: the server also asks for the alert rules,
 * and a 401/403 there means a service-account token is missing or refused.
 */
function grafanaBadge(g: MonitoringStatus['grafana'] | undefined) {
  if (!g) return <StatusBadge state="unknown" label="Grafana: checking" />
  if (!g.reachable) return <StatusBadge state="error" label="Grafana: no answer" />
  if (g.rules_status === 401 || g.rules_status === 403) {
    return <StatusBadge state="warning" label={g.has_token ? 'Grafana: token refused' : 'Grafana: needs a token'}
                        title="Grafana answers, but will not list the alert rules without a valid service-account token" />
  }
  return <StatusBadge state="ready" label="Grafana: reachable" />
}

/** A dotted metric path that may wrap after each dot, and nowhere else. */
function withBreaks(path: string) {
  const parts = path.split('.')
  return parts.map((part, i) => (
    <span key={i}>{part}{i < parts.length - 1 && <>.<wbr /></>}</span>
  ))
}

function reachBadge(reachable: boolean | undefined, what: string) {
  if (reachable === undefined) return <StatusBadge state="unknown" label={`${what}: checking`} />
  return reachable
    ? <StatusBadge state="ready" label={`${what}: reachable`} />
    : <StatusBadge state="error" label={`${what}: no answer`} />
}

export function MonitoringSettings() {
  const { toast } = useToast()
  const isRunning = useRunStatus((st) => st.isRunning)

  const [host, setHost] = useState('localhost')
  const [webPort, setWebPort] = useState('80')
  const [carbonPort, setCarbonPort] = useState('2003')
  const [prefix, setPrefix] = useState('ancillary.rates')
  const [grafanaUrl, setGrafanaUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [hasToken, setHasToken] = useState(false)
  const [legacy, setLegacy] = useState<CurrentGraphiteTarget['legacy']>(null)
  const [legacyDismissed, setLegacyDismissed] = useState(true)

  const [status, setStatus] = useState<MonitoringStatus | null>(null)
  // What is saved now (not what is typed): Detect marks a match as in use.
  const [savedCfg, setSavedCfg] = useState<{ host: string; web: number; carbon: number; grafana: string } | null>(null)
  const [confirmSave, setConfirmSave] = useState<null | { clear_api_key?: boolean }>(null)
  const [detection, setDetection] = useState<MonitoringDetection | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)

  const checkStatus = () => {
    setStatus(null)
    getMonitoringStatus().then(setStatus).catch(() => setStatus({
      graphite: { reachable: false, host: '', port: null },
      carbon: { reachable: false, host: '', port: 2003 },
      grafana: { reachable: false, url: '', version: '' },
    }))
  }

  const loadGrafana = () => getGrafanaSettings().then((g) => {
    setGrafanaUrl(g.url || '')
    setSavedCfg((prev) => ({ host: prev?.host ?? '', web: prev?.web ?? 0, carbon: prev?.carbon ?? 0, grafana: g.url || '' }))
    // The token arrives masked; the field stays empty so saving without
    // touching it keeps the stored one.
    setApiKey('')
    setHasToken(Boolean(g.api_key))
  })

  useEffect(() => {
    getStatsGraphiteConfig().then((c) => {
      setSavedCfg((prev) => ({ grafana: prev?.grafana ?? '', host: c.graphite_host || 'localhost',
                               web: Number(c.graphite_port || 80), carbon: Number(c.carbon_port || 2003) }))
      setHost(c.graphite_host || 'localhost')
      setWebPort(String(c.graphite_port || 80))
      setCarbonPort(String(c.carbon_port || 2003))
      setPrefix(c.graphite_prefix || 'ancillary.rates')
    }).catch(() => {})
    loadGrafana().catch(() => {})
    getCurrentGraphiteConfig().then((c) => setLegacy(c.legacy)).catch(() => {})
    try { setLegacyDismissed(window.localStorage.getItem(LEGACY_NOTE_KEY) === '1') } catch { setLegacyDismissed(false) }
    checkStatus()
  }, [])

  const dismissLegacy = () => {
    setLegacyDismissed(true)
    try { window.localStorage.setItem(LEGACY_NOTE_KEY, '1') } catch { /* private window: shown again next time */ }
  }

  const detect = async () => {
    setDetecting(true)
    try {
      setDetection(await detectMonitoringServers())
    } catch (e: any) {
      toast({ title: 'Detection failed', description: e?.response?.data?.error ?? 'The LUNADAQ server did not answer.', variant: 'destructive' })
    } finally {
      setDetecting(false)
    }
  }

  const pickGraphite = (g: DetectedGraphite) => {
    setHost(g.host)
    if (g.web_port) setWebPort(String(g.web_port))
    if (g.carbon_port) setCarbonPort(String(g.carbon_port))
    toast({ title: 'Filled in', description: `Graphite at ${g.host}. Press Save to use it.` })
  }

  const pickGrafana = (g: DetectedGrafana) => {
    setGrafanaUrl(g.url)
    toast({ title: 'Filled in', description: `Grafana at ${g.url}. Press Save to use it.` })
  }

  const save = async (extra: { clear_api_key?: boolean } = {}) => {
    const web = parseInt(webPort)
    const carbon = parseInt(carbonPort)
    if (!host.trim() || !(web > 0 && web < 65536) || !(carbon > 0 && carbon < 65536)) {
      toast({ title: 'Not saved', description: 'Graphite needs a host and two port numbers.', variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      const saved = await setStatsGraphiteConfig(host.trim(), web, prefix, carbon)
      if (saved?.graphite_prefix) setPrefix(saved.graphite_prefix)
      setSavedCfg((prev) => ({ grafana: prev?.grafana ?? '', host: host.trim(), web, carbon }))
      await setGrafanaSettings({ url: grafanaUrl, api_key: apiKey, ...extra })
      await loadGrafana()
      setTestResult(null)
      getCurrentGraphiteConfig().then((c) => setLegacy(c.legacy)).catch(() => {})
      toast({
        title: 'Saved',
        description: `Rates and beam current go to ${host.trim()}:${carbon}${grafanaUrl ? `; Grafana is ${grafanaUrl}` : ''}.`,
      })
      checkStatus()
    } catch (e: any) {
      toast({ title: 'Not saved', description: e?.response?.data?.error ?? 'Could not save the monitoring servers', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  // Mid-run the new addresses take effect at once: asked first, not only said.
  const requestSave = (extra: { clear_api_key?: boolean } = {}) => {
    if (isRunning) setConfirmSave(extra)
    else void save(extra)
  }

  const graphiteInUse = (g: DetectedGraphite) => !!savedCfg && g.host === savedCfg.host
    && (!g.web_port || g.web_port === savedCfg.web) && (!g.carbon_port || g.carbon_port === savedCfg.carbon)
  const grafanaInUse = (g: DetectedGrafana) => !!savedCfg?.grafana
    && g.url.replace(/\/+$/, '') === savedCfg.grafana.replace(/\/+$/, '')

  const testGrafana = async () => {
    setTesting(true)
    try {
      setTestResult(await testGrafanaConnection())
    } catch {
      setTestResult({ success: false, message: 'The LUNADAQ server could not be reached.' })
    } finally {
      setTesting(false)
    }
  }

  const nothingFound = detection && detection.graphite.length === 0 && detection.grafana.length === 0

  return (
    <div className="grid min-w-0 gap-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1 basis-64">
              <CardTitle>Find the servers</CardTitle>
              <CardDescription>
                Looks for Graphite and Grafana on this PC, on lunaserver and on the hosts already
                named here. Takes a few seconds; nothing changes until you press Save.
              </CardDescription>
            </div>
            <Button variant="outline" onClick={detect} disabled={detecting} className="max-sm:w-full">
              {detecting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Radar className="mr-1.5 h-4 w-4" />}
              {detecting ? 'Looking…' : 'Detect'}
            </Button>
          </div>
        </CardHeader>
        {detection && (
          <CardContent className="space-y-2">
            {detection.graphite.map((g) => (
              <div key={`g-${g.host}-${g.web_port}-${g.carbon_port}`}
                   className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
                <p className="min-w-0 flex-1 basis-48 break-words text-sm">
                  {g.web_port
                    ? <>Graphite at <span className="font-mono">{g.host}:{g.web_port}</span>{' '}
                        {g.carbon_port
                          ? <span className="text-muted-foreground">(Carbon {g.carbon_port})</span>
                          : <span className="text-warning">(Carbon port closed)</span>}</>
                    : <>Carbon only at <span className="font-mono">{g.host}:{g.carbon_port}</span>{' '}
                        <span className="text-muted-foreground">(no web API found)</span></>}
                </p>
                {graphiteInUse(g)
                  ? <span className="text-xs font-medium text-muted-foreground">Already in use</span>
                  : <Button size="sm" variant="secondary" className="min-h-9" onClick={() => pickGraphite(g)}>Use</Button>}
              </div>
            ))}
            {detection.grafana.map((g) => (
              <div key={`f-${g.url}`}
                   className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
                <p className="min-w-0 flex-1 basis-48 break-words text-sm">
                  Grafana at <span className="font-mono">{g.url}</span>
                  {g.version && <span className="text-muted-foreground"> (version {g.version})</span>}
                </p>
                {grafanaInUse(g)
                  ? <span className="text-xs font-medium text-muted-foreground">Already in use</span>
                  : <Button size="sm" variant="secondary" className="min-h-9" onClick={() => pickGrafana(g)}>Use</Button>}
              </div>
            ))}
            {nothingFound && (
              <p className="text-sm text-muted-foreground">
                No Graphite or Grafana answered on {detection.hosts.join(', ')}. To run both on this
                PC: <code className="font-mono">scripts/monitoring.sh start</code>, then Detect again.
              </p>
            )}
            {!nothingFound && detection.graphite.length === 0 && (
              <p className="text-sm text-muted-foreground">No Graphite found.</p>
            )}
            {!nothingFound && detection.grafana.length === 0 && (
              <p className="text-sm text-muted-foreground">No Grafana found.</p>
            )}
            <p className="text-xs text-muted-foreground">
              Looked on {detection.hosts.join(', ')} in {detection.elapsed_s} s
              {detection.unresolved.length > 0 && <> ({detection.unresolved.join(', ')}: unknown name)</>}.
            </p>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 flex-1 basis-64">
              <CardTitle>Graphite</CardTitle>
              <CardDescription>
                The one Graphite server. The DAQ counting rates and the beam current are sent to its
                Carbon port; the Stats page and monitored values read from its web port.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {reachBadge(status?.graphite.reachable, 'Web')}
              {reachBadge(status?.carbon.reachable, 'Carbon')}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {legacy && !legacyDismissed && (
            // Information, not a warning: nothing is broken, the beam current
            // simply follows this one server now. Two plain choices end it.
            <div className="space-y-2 rounded-md border bg-muted/50 px-3 py-2" role="note">
              <p className="text-sm">
                For information: the beam current now goes to the same server as the rates,{' '}
                <span className="font-mono">{status?.carbon.host || host}:{status?.carbon.port ?? carbonPort}</span>.
                An older setting sent it to <span className="font-mono">{legacy.host}:{legacy.port}</span>.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" className="min-h-9" onClick={dismissLegacy}>Keep this server</Button>
                <Button size="sm" variant="ghost" className="min-h-9" onClick={() => {
                  setHost(legacy.host)
                  setCarbonPort(String(legacy.port))
                  dismissLegacy()
                  toast({ title: 'Filled in', description: `Graphite at ${legacy.host}:${legacy.port}. Check the web port, then press Save.` })
                }}>Use {legacy.host} instead</Button>
              </div>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2 sm:col-span-3 md:col-span-1">
              <Label htmlFor="graphite-host">Host</Label>
              <Input id="graphite-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="lunaserver" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="graphite-port">Web port</Label>
              <Input id="graphite-port" inputMode="numeric" value={webPort} onChange={(e) => setWebPort(e.target.value)} placeholder="80" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="carbon-port">Carbon port</Label>
              <Input id="carbon-port" inputMode="numeric" value={carbonPort} onChange={(e) => setCarbonPort(e.target.value)} placeholder="2003" />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="graphite-prefix">Metric prefix (experiment)</Label>
            <Input id="graphite-prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="ancillary.rates.12c12c" />
            <p className="text-xs text-muted-foreground">
              Give each experiment its own subtree so campaigns never share a series: rates land under{' '}
              {/* Broken only after a dot (<wbr>), never inside a word. */}
              <code className="break-words font-mono">{withBreaks(`${prefix || 'ancillary.rates'}.bo_<board>.ch_<channel>.totalRate`)}</code>.
              The beam current keeps its own names (<code className="font-mono">tetramm.*</code>,{' '}
              <code className="font-mono">rbd9103.current</code>).
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 flex-1 basis-64">
              <CardTitle>Grafana</CardTitle>
              <CardDescription>
                The Grafana whose alert rules the Alerts page manages, and that run control activates
                and silences with the run. The LUNADAQ server makes these requests, so the address must
                be reachable from the server machine.
              </CardDescription>
            </div>
            {grafanaUrl
              ? grafanaBadge(status?.grafana)
              : <StatusBadge state="off" label="Not set" />}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="grafana-url">Grafana URL</Label>
            <Input id="grafana-url" value={grafanaUrl} onChange={(e) => setGrafanaUrl(e.target.value)} placeholder="http://lunaserver:3000" />
            <p className="text-xs text-muted-foreground">Grafana itself (usually port 3000, or 3001 on this PC) — not Graphite.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="grafana-token">Service-account token</Label>
            <Input id="grafana-token" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                   placeholder={hasToken ? 'Unchanged' : 'Not set'} autoComplete="off" />
            <p className="text-xs text-muted-foreground">
              Needed when Grafana requires a login. The token must be allowed to read and edit alert rules.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {hasToken && (
              <Button variant="outline" onClick={() => requestSave({ clear_api_key: true })} disabled={saving}>Remove token</Button>
            )}
            <Button variant="outline" onClick={testGrafana} disabled={testing || !grafanaUrl}>
              {testing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plug className="mr-1.5 h-4 w-4" />}
              Test alert-rule access
            </Button>
            {testResult && (
              <span className={`flex items-center gap-1.5 text-sm ${testResult.success ? 'text-success' : 'text-destructive'}`}>
                {testResult.success ? <CheckCircle className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
                {testResult.message}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* The running acquisition and the picoammeter take the new address up
          at once: say so before it is changed mid-run. */}
      {isRunning && (
        <p className="text-xs text-warning" role="note">
          A run is going: this applies now. The run&apos;s rates move to the new server from its next
          statistics interval, the beam current from its next sample.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => requestSave()} disabled={saving} className="max-sm:w-full">
          {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="ghost" onClick={checkStatus} disabled={saving} className="max-sm:w-full">Check again</Button>
        <p className="text-xs text-muted-foreground">
          No Graphite in the lab? <code className="font-mono">scripts/monitoring.sh start</code> runs
          Graphite and Grafana on this PC in Docker.
        </p>
      </div>
      <ConfirmAction
        open={confirmSave !== null}
        onOpenChange={(o) => { if (!o) setConfirmSave(null) }}
        title="Save during the run?"
        description={<p>A run is going: this applies now. Its rates move to the new server from the next statistics interval, the beam current from its next sample.</p>}
        confirmLabel="Save now"
        variant="default"
        onConfirm={() => { const extra = confirmSave ?? {}; setConfirmSave(null); void save(extra) }}
      />
    </div>
  )
}
