'use client'

import { useState, useEffect } from 'react'
import { Send, Eye, EyeOff, CheckCircle, XCircle, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { useToast } from '@/components/ui/use-toast'
import {
  getTelegramSettings,
  setTelegramSettings,
  testTelegram,
} from '@/lib/api'

interface TelegramSettingsData {
  enabled: boolean
  bot_token: string
  chat_id: string
  configured: boolean
}

/**
 * TelegramSettings Component
 *
 * Allows users to configure Telegram bot notifications for board failures.
 * Settings are persisted on the server and survive restarts.
 */
export function TelegramSettings() {
  const { toast } = useToast()

  const [settings, setSettings] = useState<TelegramSettingsData>({
    enabled: false,
    bot_token: '',
    chat_id: '',
    configured: false,
  })

  const [botToken, setBotToken] = useState('')
  const [chatId, setChatId] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isTesting, setIsTesting] = useState(false)

  useEffect(() => {
    fetchSettings()
  }, [])

  const fetchSettings = async () => {
    try {
      setIsLoading(true)
      const data = await getTelegramSettings()
      setSettings(data)
      setChatId(data.chat_id || '')
      // Don't set bot_token from response as it's masked
    } catch (error) {
      console.error('Failed to fetch Telegram settings:', error)
      toast({
        title: 'Error',
        description: 'Failed to load Telegram settings',
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }

  const handleEnableChange = async (checked: boolean) => {
    try {
      setIsSaving(true)
      await setTelegramSettings({ enabled: checked })
      setSettings(prev => ({ ...prev, enabled: checked }))
      toast({
        title: checked ? 'Notifications Enabled' : 'Notifications Disabled',
        description: checked
          ? 'You will receive Telegram notifications on board failures'
          : 'Telegram notifications have been disabled',
      })
    } catch (error) {
      console.error('Failed to update Telegram settings:', error)
      toast({
        title: 'Error',
        description: 'Failed to update notification settings',
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  const handleSaveCredentials = async () => {
    if (!botToken && !chatId) {
      toast({
        title: 'No Changes',
        description: 'Please enter a bot token or chat ID to save',
        variant: 'destructive',
      })
      return
    }

    try {
      setIsSaving(true)
      const updates: { bot_token?: string; chat_id?: string } = {}

      if (botToken) {
        updates.bot_token = botToken
      }
      if (chatId !== settings.chat_id) {
        updates.chat_id = chatId
      }

      await setTelegramSettings(updates)
      await fetchSettings()

      setBotToken('') // Clear the input after saving

      toast({
        title: 'Settings Saved',
        description: 'Telegram credentials have been updated',
      })
    } catch (error) {
      console.error('Failed to save Telegram credentials:', error)
      toast({
        title: 'Error',
        description: 'Failed to save credentials',
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  const handleTestNotification = async () => {
    try {
      setIsTesting(true)
      const response = await testTelegram()
      toast({
        title: 'Test Successful',
        description: response.data.message || 'Test message sent successfully',
      })
    } catch (error: any) {
      console.error('Failed to send test notification:', error)
      toast({
        title: 'Test Failed',
        description: error.response?.data?.message || 'Failed to send test message',
        variant: 'destructive',
      })
    } finally {
      setIsTesting(false)
    }
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Telegram Notifications</CardTitle>
          <CardDescription>Loading settings...</CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center py-8">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Send className="h-5 w-5" />
          Telegram Notifications
        </CardTitle>
        <CardDescription>
          Receive instant notifications on Telegram when board failures occur during data acquisition.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Enable/Disable Toggle */}
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="space-y-0.5">
            <Label htmlFor="telegram-enabled" className="text-base">
              Enable Notifications
            </Label>
            <p className="text-sm text-muted-foreground">
              Send alerts when board failures are detected
            </p>
          </div>
          <div className="flex items-center gap-2">
            {settings.configured ? (
              <CheckCircle className="h-4 w-4 text-green-500" />
            ) : (
              <XCircle className="h-4 w-4 text-red-500" />
            )}
            <Checkbox
              id="telegram-enabled"
              checked={settings.enabled}
              onCheckedChange={handleEnableChange}
              disabled={!settings.configured || isSaving}
            />
          </div>
        </div>

        {!settings.configured && (
          <p className="text-sm text-amber-600">
            Configure your bot token and chat ID below to enable notifications.
          </p>
        )}

        {/* Bot Token Input */}
        <div className="space-y-2">
          <Label htmlFor="bot-token">Bot Token</Label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                id="bot-token"
                type={showToken ? 'text' : 'password'}
                placeholder={settings.bot_token || 'Enter your Telegram bot token'}
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                onClick={() => setShowToken(!showToken)}
              >
                {showToken ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Create a bot with @BotFather on Telegram to get your token
          </p>
        </div>

        {/* Chat ID Input */}
        <div className="space-y-2">
          <Label htmlFor="chat-id">Chat ID</Label>
          <Input
            id="chat-id"
            type="text"
            placeholder="Enter your Telegram chat ID"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Send a message to @userinfobot on Telegram to get your chat ID
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            onClick={handleSaveCredentials}
            disabled={isSaving || (!botToken && chatId === settings.chat_id)}
            className="flex-1"
          >
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              'Save Credentials'
            )}
          </Button>
          <Button
            variant="outline"
            onClick={handleTestNotification}
            disabled={!settings.configured || isTesting}
            className="flex-1"
          >
            {isTesting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <Send className="mr-2 h-4 w-4" />
                Send Test Message
              </>
            )}
          </Button>
        </div>

        {/* Info Box */}
        <div className="rounded-lg bg-muted p-4 text-sm">
          <h4 className="font-medium mb-2">How it works:</h4>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>Notifications are sent when a board reports &quot;Generic Failure&quot; or &quot;PLL Lock&quot; error</li>
            <li>Only one notification is sent per run, even if multiple failures occur</li>
            <li>If auto-restart is enabled, the notification will indicate that a restart is in progress</li>
            <li>A new notification will be sent if failure occurs in a subsequent run</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  )
}
