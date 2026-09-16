'use client'

import { useEffect, useState } from 'react'
import { CheckCircle, XCircle, Loader2, Plug } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'
import { useToast } from '@/components/ui/use-toast'
import {
  getGrafanaSettings, setGrafanaSettings, testGrafanaConnection,
  type GrafanaSettings as GrafanaSettingsData,
} from '@/lib/api'

/**
 * Where the WebDAQ server reaches Grafana for the Alerts page and run-linked
 * alerts. Both the address and the token stay on the server.
 */
export function GrafanaSettings() {
  const { toast } = useToast()

  const [settings, setSettings] = useState<GrafanaSettingsData | null>(null)
  const [url, setUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)

  useEffect(() => { fetchSettings() }, [])

  async function fetchSettings() {
    try {
      setLoading(true)
      const data = await getGrafanaSettings()
      setSettings(data)
      setUrl(data.url || '')
      // The token arrives masked; leave the field empty so saving without
      // touching it keeps the stored one.
      setApiKey('')
    } catch (error) {
      console.error('Failed to fetch Grafana settings:', error)
      toast({ title: 'Error', description: 'Failed to load Grafana settings', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  async function save(extra: { clear_api_key?: boolean } = {}) {
    try {
      setSaving(true)
      await setGrafanaSettings({ url, api_key: apiKey, ...extra })
      setTestResult(null)
      await fetchSettings()
      toast({ title: 'Saved', description: 'Grafana settings updated.' })
    } catch (error) {
      console.error('Failed to save Grafana settings:', error)
      toast({ title: 'Error', description: 'Failed to save Grafana settings', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  async function handleTest() {
    try {
      setTesting(true)
      setTestResult(await testGrafanaConnection())
    } catch (error) {
      setTestResult({ success: false, message: 'The WebDAQ server could not be reached.' })
    } finally {
      setTesting(false)
    }
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
    <Card>
      <CardHeader>
        <CardTitle>Grafana</CardTitle>
        <CardDescription>
          The Grafana server whose alert rules the Alerts page manages, and that run control
          activates and silences with the run. The WebDAQ server makes these requests, so the
          address must be reachable from the server machine.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="grafana-url">Grafana URL</Label>
          <Input
            id="grafana-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://lunaserver:3000"
          />
          <p className="text-xs text-muted-foreground">
            Grafana itself (usually port 3000) — not Graphite.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="grafana-token">Service-account token</Label>
          <Input
            id="grafana-token"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={settings?.api_key ? 'Unchanged' : 'Not set'}
          />
          <p className="text-xs text-muted-foreground">
            Needed when Grafana requires a login. The token must be allowed to read and edit
            alert rules.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => save()} disabled={saving}>
            {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            Save
          </Button>
          {settings?.api_key && (
            <Button variant="outline" onClick={() => save({ clear_api_key: true })} disabled={saving}>
              Remove token
            </Button>
          )}
          <Button variant="outline" onClick={handleTest} disabled={testing || !settings?.url}>
            {testing
              ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              : <Plug className="mr-1.5 h-4 w-4" />}
            Test connection
          </Button>
          {testResult && (
            <span className={`flex items-center gap-1.5 text-sm ${
              testResult.success ? 'text-green-600 dark:text-green-400' : 'text-destructive'}`}>
              {testResult.success
                ? <CheckCircle className="h-4 w-4" />
                : <XCircle className="h-4 w-4" />}
              {testResult.message}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
