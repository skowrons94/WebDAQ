'use client'

import { useEffect, useState } from 'react'
import { CheckCircle, XCircle, Loader2, Plug, Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'
import { useToast } from '@/components/ui/use-toast'
import {
  getElogSettings, setElogSettings, testElogConnection, type ElogSettings as ElogSettingsData,
} from '@/lib/api'

/**
 * Connection settings for the shared PSI ELOG account.
 *
 * One account authenticates for everyone; entries are still signed with the
 * WebDAQ user's name through the Author attribute, so attribution survives.
 */
export function ElogSettings() {
  const { toast } = useToast()

  const [settings, setSettings] = useState<ElogSettingsData | null>(null)
  const [url, setUrl] = useState('')
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [attributes, setAttributes] = useState<[string, string][]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)

  useEffect(() => { fetchSettings() }, [])

  async function fetchSettings() {
    try {
      setLoading(true)
      const data = await getElogSettings()
      setSettings(data)
      setUrl(data.url || '')
      setUser(data.user || '')
      setAttributes(Object.entries(data.default_attributes || {}))
      // The password arrives masked; leave the field empty so saving without
      // touching it keeps the stored one.
      setPassword('')
    } catch (error) {
      console.error('Failed to fetch ELOG settings:', error)
      toast({ title: 'Error', description: 'Failed to load ELOG settings', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  async function handleSave() {
    try {
      setSaving(true)
      const defaults = Object.fromEntries(attributes.filter(([name]) => name.trim()))
      await setElogSettings({ url, user, password, default_attributes: defaults })
      setPassword('')
      setTestResult(null)
      await fetchSettings()
      toast({ title: 'Saved', description: 'ELOG settings updated.' })
    } catch (error) {
      console.error('Failed to save ELOG settings:', error)
      toast({ title: 'Error', description: 'Failed to save ELOG settings', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  async function handleEnabledChange(checked: boolean) {
    try {
      await setElogSettings({ enabled: checked })
      setSettings(prev => (prev ? { ...prev, enabled: checked } : prev))
      toast({
        title: checked ? 'Posting enabled' : 'Posting disabled',
        description: checked
          ? 'WebDAQ may submit entries to the logbook.'
          : 'Entries can be read but not submitted.',
      })
    } catch (error) {
      console.error('Failed to update ELOG settings:', error)
      toast({ title: 'Error', description: 'Failed to update ELOG settings', variant: 'destructive' })
    }
  }

  async function handleTest() {
    try {
      setTesting(true)
      setTestResult(await testElogConnection())
    } catch (error) {
      setTestResult({ success: false, message: 'The server could not be reached.' })
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
        <CardTitle>ELOG</CardTitle>
        <CardDescription>
          Connect WebDAQ to the collaboration&apos;s PSI ELOG logbook. One shared account is used for
          the connection; each entry is signed with the WebDAQ user who writes it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {settings && !settings.available && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            The <code>py_elog</code> package is not installed on the server, so reading and posting
            will fail. Install it with <code>conda install -c paulscherrerinstitute elog</code>{' '}
            and restart the server.
          </p>
        )}

        <div className="space-y-2">
          <Label htmlFor="elog-url">Logbook URL</Label>
          <Input
            id="elog-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://elog.example.org/elogs/LUNA/"
          />
          <p className="text-xs text-muted-foreground">
            The full address of the logbook, as it appears in the browser.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="elog-user">Username</Label>
            <Input
              id="elog-user"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder="Leave empty if the logbook needs no login"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="elog-password">Password</Label>
            <Input
              id="elog-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={settings?.password ? 'Unchanged' : 'Not set'}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label>Default attributes</Label>
          <p className="text-xs text-muted-foreground">
            Filled into every new entry — useful for fields the logbook requires, such as
            a category or a system name.
          </p>
          <div className="space-y-2">
            {attributes.map(([name, value], index) => (
              <div key={index} className="flex gap-2">
                <Input
                  className="h-9"
                  placeholder="Attribute"
                  value={name}
                  onChange={(e) => setAttributes(a =>
                    a.map((pair, i) => (i === index ? [e.target.value, pair[1]] : pair)))}
                />
                <Input
                  className="h-9"
                  placeholder="Value"
                  value={value}
                  onChange={(e) => setAttributes(a =>
                    a.map((pair, i) => (i === index ? [pair[0], e.target.value] : pair)))}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-9 text-destructive"
                  onClick={() => setAttributes(a => a.filter((_, i) => i !== index))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAttributes(a => [...a, ['', '']])}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              Add attribute
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="elog-enabled"
            checked={settings?.enabled ?? false}
            onCheckedChange={(checked) => handleEnabledChange(checked === true)}
          />
          <Label htmlFor="elog-enabled">Allow WebDAQ to post entries</Label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            Save
          </Button>
          <Button variant="outline" onClick={handleTest} disabled={testing || !url}>
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
