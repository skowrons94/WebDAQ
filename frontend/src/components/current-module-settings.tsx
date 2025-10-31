'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import {
  getCurrentModuleType,
  setCurrentModuleType,
  getCurrentModuleSettings,
  updateCurrentModuleSettings,
  getCurrentStatus,
  getCurrentGraphiteConfig,
  setCurrentGraphiteConfig
} from '@/lib/api'

interface ModuleSettings {
  module_type: string
  ip?: string
  port?: number | string
  baudrate?: number
  high_speed?: boolean
  settings?: any
}

export function CurrentModuleSettings() {
  const { toast } = useToast()
  const [moduleType, setModuleTypeState] = useState<string>('tetramm')
  const [moduleSettings, setModuleSettings] = useState<ModuleSettings | null>(null)
  const [status, setStatus] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [switching, setSwitching] = useState(false)

  // TetrAMM settings
  const [tetramIp, setTetramIp] = useState('169.254.145.10')
  const [tetramPort, setTetramPort] = useState('10001')
  const [tetramChn, setTetramChn] = useState('4')
  const [tetramRange, setTetramRange] = useState('AUTO')
  const [tetramNrSamp, setTetramNrSamp] = useState('10000')

  // RBD 9103 settings
  const [rbdPort, setRbdPort] = useState('/dev/tty.usbserial-A50285BI')
  const [rbdBaudrate, setRbdBaudrate] = useState('57600')
  const [rbdHighSpeed, setRbdHighSpeed] = useState(false)
  const [rbdRange, setRbdRange] = useState('R0')
  const [rbdFilter, setRbdFilter] = useState('F032')
  const [rbdInputMode, setRbdInputMode] = useState('G0')
  const [rbdBias, setRbdBias] = useState('B0')

  // Graphite configuration
  const [graphiteHost, setGraphiteHost] = useState('172.18.9.54')
  const [graphitePort, setGraphitePort] = useState('2003')

  useEffect(() => {
    loadSettings()
    const interval = setInterval(() => {
      loadStatus()
    }, 2000)
    return () => clearInterval(interval)
  }, [])

  const loadGraphiteConfig = async () => {
    try {
      const config = await getCurrentGraphiteConfig()
      setGraphiteHost(config.graphite_host || '172.18.9.54')
      setGraphitePort(String(config.graphite_port || 2003))
    } catch (error) {
      console.error('Error loading graphite config:', error)
    }
  }

  const loadSettings = async () => {
    try {
      setLoading(true)

      // Get current module type first
      const typeResponse = await getCurrentModuleType()
      setModuleTypeState(typeResponse.module_type)

      // Load graphite configuration
      await loadGraphiteConfig()

      // Get module settings - this should work even if device is disconnected
      console.log('Loading module settings...')
      const settingsResponse = await getCurrentModuleSettings()
      console.log('Module settings loaded:', settingsResponse)
      setModuleSettings(settingsResponse)

      // Populate form fields based on module type
      if (settingsResponse.module_type === 'tetramm') {
        setTetramIp(settingsResponse.ip || '169.254.145.10')
        setTetramPort(String(settingsResponse.port || 10001))
        if (settingsResponse.settings) {
          setTetramChn(settingsResponse.settings.CHN || '4')
          setTetramRange(settingsResponse.settings.RNG || 'AUTO')
          setTetramNrSamp(settingsResponse.settings.NRSAMP || '10000')
        }
      } else if (settingsResponse.module_type === 'rbd9103') {
        setRbdPort(settingsResponse.port || '/dev/tty.usbserial-A50285BI')
        setRbdBaudrate(String(settingsResponse.baudrate || 57600))
        setRbdHighSpeed(settingsResponse.high_speed || false)
        if (settingsResponse.settings) {
          setRbdRange(settingsResponse.settings.range || 'R0')
          setRbdFilter(settingsResponse.settings.filter || 'F032')
          setRbdInputMode(settingsResponse.settings.input_mode || 'G0')
          setRbdBias(settingsResponse.settings.bias || 'B0')
        }
      }

      // Load status - continue even if this fails
      try {
        await loadStatus()
      } catch (statusError) {
        console.warn('Failed to load status, but continuing:', statusError)
        // Set a default status if status loading fails
        setStatus({
          connected: false,
          running: false,
          acquiring: false,
          thread_alive: false,
          module_type: typeResponse.module_type
        })
      }

    } catch (error: any) {
      console.error('Error loading settings:', error)
      toast({
        title: 'Error',
        description: `Failed to load module settings: ${error.response?.data?.error || error.message || 'Unknown error'}`,
        variant: 'destructive'
      })
    } finally {
      setLoading(false)
    }
  }

  const loadStatus = async () => {
    try {
      console.log('Loading status...')
      const statusResponse = await getCurrentStatus()
      console.log('Status loaded:', statusResponse)
      setStatus(statusResponse)
    } catch (error) {
      console.error('Error loading status:', error)
      // Don't throw the error, just set a default status
      setStatus({
        connected: false,
        running: false,
        acquiring: false,
        thread_alive: false,
        module_type: moduleType
      })
    }
  }

  const handleSwitchModule = async (newModuleType: string) => {
    if (newModuleType === moduleType) return

    try {
      setSwitching(true)
      await setCurrentModuleType(newModuleType)

      toast({
        title: 'Success',
        description: `Switched to ${newModuleType === 'tetramm' ? 'TetrAMM' : 'RBD 9103'}`
      })

      // Reload settings
      await loadSettings()
      setModuleTypeState(newModuleType)

    } catch (error: any) {
      console.error('Error switching module:', error)
      toast({
        title: 'Error',
        description: error.response?.data?.error || 'Failed to switch module',
        variant: 'destructive'
      })
    } finally {
      setSwitching(false)
    }
  }

  const handleSaveTetrammSettings = async () => {
    try {
      const settingsData = {
        ip: tetramIp,
        port: parseInt(tetramPort),
        device_settings: {
          CHN: tetramChn,
          RNG: tetramRange,
          NRSAMP: tetramNrSamp
        }
      }

      await updateCurrentModuleSettings(settingsData)

      toast({
        title: 'Success',
        description: 'TetrAMM settings updated'
      })

      await loadSettings()

    } catch (error: any) {
      console.error('Error saving TetrAMM settings:', error)
      toast({
        title: 'Error',
        description: error.response?.data?.error || 'Failed to save TetrAMM settings',
        variant: 'destructive'
      })
    }
  }

  const handleSaveRbdSettings = async () => {
    try {
      const settingsData = {
        port: rbdPort,
        baudrate: parseInt(rbdBaudrate),
        high_speed: rbdHighSpeed,
        device_settings: {
          range: rbdRange,
          filter: rbdFilter,
          input_mode: rbdInputMode,
          bias: rbdBias
        }
      }

      await updateCurrentModuleSettings(settingsData)

      toast({
        title: 'Success',
        description: 'RBD 9103 settings updated'
      })

      await loadSettings()

    } catch (error: any) {
      console.error('Error saving RBD 9103 settings:', error)
      toast({
        title: 'Error',
        description: error.response?.data?.error || 'Failed to save RBD 9103 settings',
        variant: 'destructive'
      })
    }
  }

  const handleSaveGraphiteConfig = async () => {
    try {
      await setCurrentGraphiteConfig(graphiteHost, parseInt(graphitePort))

      toast({
        title: 'Success',
        description: 'Graphite server configuration updated'
      })

      await loadGraphiteConfig()

    } catch (error: any) {
      console.error('Error saving Graphite config:', error)
      toast({
        title: 'Error',
        description: error.response?.data?.error || 'Failed to save Graphite configuration',
        variant: 'destructive'
      })
    }
  }

  if (loading) {
    return <div>Loading...</div>
  }

  return (
    <div className="space-y-6">
      {/* Module Selection */}
      <Card>
        <CardHeader>
          <CardTitle>Current Measurement Module</CardTitle>
          <CardDescription>
            Select which picoammeter module to use for current measurements
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <Label htmlFor="module-select">Active Module</Label>
              <Select
                value={moduleType}
                onValueChange={handleSwitchModule}
                disabled={switching || status?.running}
              >
                <SelectTrigger id="module-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="tetramm">TetrAMM (4-channel TCP/IP)</SelectItem>
                  <SelectItem value="rbd9103">RBD 9103 (Single-channel Serial)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              {status?.connected ? (
                <Badge variant="default" className="bg-green-500">Connected</Badge>
              ) : (
                <Badge variant="secondary">Disconnected</Badge>
              )}
              {status?.running && (
                <Badge variant="default" className="bg-blue-500">Acquiring</Badge>
              )}
            </div>
          </div>
          {status?.running && (
            <p className="text-sm text-amber-600">
              Stop current acquisition before switching modules
            </p>
          )}
        </CardContent>
      </Card>

      {/* Module-specific settings */}
      <Tabs value={moduleType} className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="tetramm">TetrAMM Settings</TabsTrigger>
          <TabsTrigger value="rbd9103">RBD 9103 Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="tetramm">
          <Card>
            <CardHeader>
              <CardTitle>TetrAMM Configuration</CardTitle>
              <CardDescription>
                Configure TCP/IP connection and device parameters for TetrAMM 4-channel picoammeter
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Connection Settings */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="tetram-ip">IP Address</Label>
                  <Input
                    id="tetram-ip"
                    value={tetramIp}
                    onChange={(e) => setTetramIp(e.target.value)}
                    placeholder="169.254.145.10"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tetram-port">Port</Label>
                  <Input
                    id="tetram-port"
                    value={tetramPort}
                    onChange={(e) => setTetramPort(e.target.value)}
                    placeholder="10001"
                  />
                </div>
              </div>

              {/* Device Settings */}
              <div className="space-y-2">
                <Label htmlFor="tetram-chn">Number of Channels</Label>
                <Select value={tetramChn} onValueChange={setTetramChn}>
                  <SelectTrigger id="tetram-chn">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 Channel</SelectItem>
                    <SelectItem value="2">2 Channels</SelectItem>
                    <SelectItem value="3">3 Channels</SelectItem>
                    <SelectItem value="4">4 Channels</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="tetram-range">Range</Label>
                <Input
                  id="tetram-range"
                  value={tetramRange}
                  onChange={(e) => setTetramRange(e.target.value)}
                  placeholder="AUTO"
                />
                <p className="text-xs text-muted-foreground">
                  AUTO for automatic range, or specify range (e.g., 20nA, 200nA, 2uA, etc.)
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="tetram-nrsamp">Number of Samples</Label>
                <Input
                  id="tetram-nrsamp"
                  value={tetramNrSamp}
                  onChange={(e) => setTetramNrSamp(e.target.value)}
                  placeholder="10000"
                />
                <p className="text-xs text-muted-foreground">
                  Number of samples per measurement acquisition
                </p>
              </div>

              <Button onClick={handleSaveTetrammSettings} className="w-full">
                Save TetrAMM Settings
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rbd9103">
          <Card>
            <CardHeader>
              <CardTitle>RBD 9103 Configuration</CardTitle>
              <CardDescription>
                Configure serial connection and device parameters for RBD 9103 picoammeter
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Connection Settings */}
              <div className="space-y-2">
                <Label htmlFor="rbd-port">Serial Port</Label>
                <Input
                  id="rbd-port"
                  value={rbdPort}
                  onChange={(e) => setRbdPort(e.target.value)}
                  placeholder="/dev/ttyUSB0"
                />
                <p className="text-xs text-muted-foreground">
                  USB serial port device path (e.g., /dev/ttyUSB0 on Linux, COM3 on Windows)
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="rbd-baudrate">Baud Rate</Label>
                  <Select value={rbdBaudrate} onValueChange={setRbdBaudrate}>
                    <SelectTrigger id="rbd-baudrate">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="57600">57600 (Standard Speed)</SelectItem>
                      <SelectItem value="230400">230400 (High Speed)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rbd-high-speed">Speed Mode</Label>
                  <Select
                    value={rbdHighSpeed ? 'true' : 'false'}
                    onValueChange={(v) => setRbdHighSpeed(v === 'true')}
                  >
                    <SelectTrigger id="rbd-high-speed">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="false">Standard (1 sample/msg)</SelectItem>
                      <SelectItem value="true">High Speed (10 samples/msg)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Device Settings */}
              <div className="space-y-2">
                <Label htmlFor="rbd-range">Range</Label>
                <Select value={rbdRange} onValueChange={setRbdRange}>
                  <SelectTrigger id="rbd-range">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="R0">R0 - Auto Range</SelectItem>
                    <SelectItem value="R1">R1 - 20 nA</SelectItem>
                    <SelectItem value="R2">R2 - 200 nA</SelectItem>
                    <SelectItem value="R3">R3 - 2 µA</SelectItem>
                    <SelectItem value="R4">R4 - 20 µA</SelectItem>
                    <SelectItem value="R5">R5 - 200 µA</SelectItem>
                    <SelectItem value="R6">R6 - 2 mA</SelectItem>
                    <SelectItem value="R7">R7 - 20 mA</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="rbd-filter">Filter (Samples Averaging)</Label>
                <Select value={rbdFilter} onValueChange={setRbdFilter}>
                  <SelectTrigger id="rbd-filter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="F001">F001 - 1 sample</SelectItem>
                    <SelectItem value="F002">F002 - 2 samples</SelectItem>
                    <SelectItem value="F004">F004 - 4 samples</SelectItem>
                    <SelectItem value="F008">F008 - 8 samples</SelectItem>
                    <SelectItem value="F016">F016 - 16 samples</SelectItem>
                    <SelectItem value="F032">F032 - 32 samples</SelectItem>
                    <SelectItem value="F064">F064 - 64 samples</SelectItem>
                    <SelectItem value="F128">F128 - 128 samples</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="rbd-input-mode">Input Mode</Label>
                <Select value={rbdInputMode} onValueChange={setRbdInputMode}>
                  <SelectTrigger id="rbd-input-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="G0">G0 - Normal Input</SelectItem>
                    <SelectItem value="G1">G1 - Alternate Input Mode</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="rbd-bias">Bias Voltage</Label>
                <Select value={rbdBias} onValueChange={setRbdBias}>
                  <SelectTrigger id="rbd-bias">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="B0">B0 - Bias Off</SelectItem>
                    <SelectItem value="B1">B1 - Bias On</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <Button onClick={handleSaveRbdSettings} className="w-full">
                Save RBD 9103 Settings
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Status Information */}
      {status && (
        <Card>
          <CardHeader>
            <CardTitle>Module Status</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="font-medium">Module Type:</span>{' '}
                {status.module_type === 'tetramm' ? 'TetrAMM' : 'RBD 9103'}
              </div>
              <div>
                <span className="font-medium">Connected:</span>{' '}
                {status.connected ? 'Yes' : 'No'}
              </div>
              <div>
                <span className="font-medium">Acquiring:</span>{' '}
                {status.acquiring ? 'Yes' : 'No'}
              </div>
              <div>
                <span className="font-medium">Thread Alive:</span>{' '}
                {status.thread_alive ? 'Yes' : 'No'}
              </div>
              {status.latest_measurement !== undefined && (
                <div className="col-span-2">
                  <span className="font-medium">Latest Measurement:</span>{' '}
                  {status.latest_measurement.toFixed(3)} µA
                </div>
              )}
              {status.latest_measurements && (
                <div className="col-span-2">
                  <span className="font-medium">Latest Measurements (µA):</span>
                  <div className="grid grid-cols-4 gap-2 mt-2">
                    {Object.entries(status.latest_measurements).map(([ch, val]: [string, any]) => (
                      <div key={ch}>
                        Ch{ch}: {val.toFixed(3)}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Graphite Server Configuration */}
      <Card>
        <CardHeader>
          <CardTitle>Graphite Server Configuration</CardTitle>
          <CardDescription>
            Configure the Graphite server for sending current measurement metrics
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="graphite-host">Graphite Host</Label>
              <Input
                id="graphite-host"
                value={graphiteHost}
                onChange={(e) => setGraphiteHost(e.target.value)}
                placeholder="172.18.9.54"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="graphite-port">Graphite Port</Label>
              <Input
                id="graphite-port"
                value={graphitePort}
                onChange={(e) => setGraphitePort(e.target.value)}
                placeholder="2003"
              />
            </div>
          </div>
          <Button onClick={handleSaveGraphiteConfig} className="w-full">
            Save Graphite Configuration
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
