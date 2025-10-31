'use client'

import { useState, useEffect } from 'react'
import { Plus, Trash2, Eye, EyeOff, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Layout } from '@/components/dashboard-layout';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useStatsStore } from '@/store/stats-store'
import {
  getStatsPaths,
  addStatsPath,
  removeStatsPath,
  updateStatsPath,
  getStatsMetricLastValue,
  getStatsGraphiteConfig,
  setStatsGraphiteConfig,
} from '@/lib/api'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'

type StatPath = {
  path: string
  alias: string
  enabled: boolean
}

export default function StatsPage() {
  const { toast } = useToast()
  const { paths, currentValues, setCurrentValue, setPaths, setError } = useStatsStore()
  const [newPath, setNewPath] = useState('')
  const [newAlias, setNewAlias] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [pathToDelete, setPathToDelete] = useState<string | null>(null)
  const [error, setLocalError] = useState<string | null>(null)

  // Graphite configuration
  const [graphiteHost, setGraphiteHost] = useState('localhost')
  const [graphitePort, setGraphitePort] = useState('80')
  const [showGraphiteConfig, setShowGraphiteConfig] = useState(false)

  // Load graphite config
  useEffect(() => {
    const loadGraphiteConfig = async () => {
      try {
        const config = await getStatsGraphiteConfig()
        setGraphiteHost(config.graphite_host || 'localhost')
        setGraphitePort(String(config.graphite_port || 80))
      } catch (error) {
        console.error('Failed to load graphite config:', error)
      }
    }

    loadGraphiteConfig()
  }, [])

  // Load paths on mount
  useEffect(() => {
    const loadPaths = async () => {
      try {
        setIsLoading(true)
        const data = await getStatsPaths()
        setPaths(data || [])
        setLocalError(null)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load paths'
        setLocalError(message)
      } finally {
        setIsLoading(false)
      }
    }

    loadPaths()
  }, [setPaths])

  // Refresh values for all enabled paths
  useEffect(() => {
    const refreshValues = async () => {
      for (const path of paths.filter(p => p.enabled)) {
        try {
          const data = await getStatsMetricLastValue(path.path)
          if (data && data.value !== undefined) {
            setCurrentValue(path.path, data.value, data.timestamp)
          }
        } catch (err) {
          console.error(`Failed to fetch value for ${path.path}:`, err)
        }
      }
    }

    if (paths.length > 0) {
      refreshValues()
      const interval = setInterval(refreshValues, 5000) // Refresh every 5 seconds
      return () => clearInterval(interval)
    }
  }, [paths, setCurrentValue])

  const handleAddPath = async () => {
    if (!newPath.trim()) {
      setLocalError('Path is required')
      return
    }

    try {
      setIsLoading(true)
      await addStatsPath(newPath, newAlias || newPath)

      // Reload paths
      const data = await getStatsPaths()
      setPaths(data || [])

      setNewPath('')
      setNewAlias('')
      setLocalError(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add path'
      setLocalError(message)
    } finally {
      setIsLoading(false)
    }
  }

  const handleDeletePath = async (path: string) => {
    try {
      setIsLoading(true)
      await removeStatsPath(path)

      // Reload paths
      const data = await getStatsPaths()
      setPaths(data || [])

      setPathToDelete(null)
      setLocalError(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete path'
      setLocalError(message)
    } finally {
      setIsLoading(false)
    }
  }

  const handleTogglePath = async (path: string, currentEnabled: boolean) => {
    try {
      setIsLoading(true)
      await updateStatsPath(path, undefined, !currentEnabled)

      // Reload paths
      const data = await getStatsPaths()
      setPaths(data || [])

      setLocalError(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update path'
      setLocalError(message)
    } finally {
      setIsLoading(false)
    }
  }

  const handleRefreshValues = async () => {
    try {
      setIsLoading(true)
      for (const path of paths.filter(p => p.enabled)) {
        try {
          const data = await getStatsMetricLastValue(path.path)
          if (data && data.value !== undefined) {
            setCurrentValue(path.path, data.value, data.timestamp)
          }
        } catch (err) {
          console.error(`Failed to fetch value for ${path.path}:`, err)
        }
      }
      setLocalError(null)
    } finally {
      setIsLoading(false)
    }
  }

  const handleSaveGraphiteConfig = async () => {
    try {
      await setStatsGraphiteConfig(graphiteHost, parseInt(graphitePort))
      toast({
        title: 'Success',
        description: 'Graphite server configuration updated'
      })
    } catch (error: any) {
      console.error('Error saving Graphite config:', error)
      toast({
        title: 'Error',
        description: error.response?.data?.error || 'Failed to save Graphite configuration',
        variant: 'destructive'
      })
    }
  }

  return (
    <Layout>
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold tracking-tight">Stats & Graphite Metrics</h1>
        <Button
          onClick={handleRefreshValues}
          disabled={isLoading}
          variant="outline"
          size="sm"
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      {/* Error Alert */}
      {error && (
        <Card className="border-red-500 bg-red-50">
          <CardContent className="pt-6">
            <p className="text-red-800">{error}</p>
            <Button
              onClick={() => setLocalError(null)}
              variant="ghost"
              size="sm"
              className="mt-2"
            >
              Dismiss
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Graphite Server Configuration */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>Graphite Server Configuration</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowGraphiteConfig(!showGraphiteConfig)}
          >
            {showGraphiteConfig ? 'Hide' : 'Show'}
          </Button>
        </CardHeader>
        {showGraphiteConfig && (
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="stats-graphite-host">Graphite Host</Label>
                <Input
                  id="stats-graphite-host"
                  value={graphiteHost}
                  onChange={(e) => setGraphiteHost(e.target.value)}
                  placeholder="localhost"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="stats-graphite-port">Graphite Port</Label>
                <Input
                  id="stats-graphite-port"
                  value={graphitePort}
                  onChange={(e) => setGraphitePort(e.target.value)}
                  placeholder="80"
                />
              </div>
            </div>
            <Button onClick={handleSaveGraphiteConfig} className="w-full">
              Save Graphite Configuration
            </Button>
          </CardContent>
        )}
      </Card>

      {/* Add New Path */}
      <Card>
        <CardHeader>
          <CardTitle>Add New Metric Path</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="path" className="text-sm font-medium">
              Graphite Path
            </label>
            <Input
              id="path"
              placeholder="e.g., accelerator.terminal_voltage"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddPath()}
              disabled={isLoading}
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="alias" className="text-sm font-medium">
              Display Name (Optional)
            </label>
            <Input
              id="alias"
              placeholder="e.g., Terminal Voltage"
              value={newAlias}
              onChange={(e) => setNewAlias(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddPath()}
              disabled={isLoading}
            />
          </div>

          <Button
            onClick={handleAddPath}
            disabled={isLoading || !newPath.trim()}
            className="w-full"
          >
            <Plus className="mr-2 h-4 w-4" />
            Add Path
          </Button>
        </CardContent>
      </Card>

      {/* Configured Paths */}
      <Card>
        <CardHeader>
          <CardTitle>
            Configured Metrics ({paths.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {paths.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No metric paths configured yet. Add one above to get started.
            </p>
          ) : (
            <div className="space-y-2">
              {paths.map((path) => (
                <div
                  key={path.path}
                  className="flex items-center justify-between p-4 border rounded-lg hover:bg-accent transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleTogglePath(path.path, path.enabled)}
                        disabled={isLoading}
                      >
                        {path.enabled ? (
                          <Eye className="h-4 w-4 text-green-600" />
                        ) : (
                          <EyeOff className="h-4 w-4 text-gray-400" />
                        )}
                      </Button>

                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate">{path.alias}</p>
                        <p className="text-xs text-muted-foreground truncate">{path.path}</p>
                      </div>
                    </div>
                  </div>

                  {/* Current Value */}
                  <div className="flex-shrink-0 ml-4 text-right">
                    {path.enabled && currentValues[path.path] ? (
                      <div>
                        <p className="text-lg font-semibold">
                          {currentValues[path.path].value !== null
                            ? typeof currentValues[path.path].value === 'number'
                              ? (currentValues[path.path].value as number).toFixed(2)
                              : currentValues[path.path].value
                            : 'N/A'}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {currentValues[path.path].timestamp
                            ? new Date(currentValues[path.path].timestamp as string).toLocaleTimeString()
                            : 'No data'}
                        </p>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">Disabled</p>
                    )}
                  </div>

                  {/* Delete Button */}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPathToDelete(path.path)}
                    disabled={isLoading}
                    className="ml-2"
                  >
                    <Trash2 className="h-4 w-4 text-red-600" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!pathToDelete} onOpenChange={(open) => !open && setPathToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>Delete Metric Path</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete this metric path? This action cannot be undone.
          </AlertDialogDescription>
          <div className="flex justify-end gap-2">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => pathToDelete && handleDeletePath(pathToDelete)}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </Layout>
  )
}
