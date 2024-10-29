import { useVisualizationStore } from '@/store/visualization-settings-store'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { useTheme } from 'next-themes'
import { set } from 'react-hook-form'

export function VisualizationSettings() {
    const { settings, updateSettings, resetSettings } = useVisualizationStore()
    const { toast } = useToast()
    const { setTheme } = useTheme()

    return (
        <Card>
            <CardHeader>
                <CardTitle>Visualization Settings</CardTitle>
                <CardDescription>
                    Customize how charts and data are displayed across the dashboard
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
                <div className="grid gap-4">
                    <div className="space-y-2">
                        <Label htmlFor="theme">Theme</Label>
                        <Select
                            value={settings.theme}
                            onValueChange={(value) => setTheme(value)}
                        >
                            <SelectTrigger id="theme">
                                <SelectValue placeholder="Select theme" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="light">Light</SelectItem>
                                <SelectItem value="dark">Dark</SelectItem>
                                <SelectItem value="system">System</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="flex items-center justify-between">
                        <Label htmlFor="showLegend">Show Stats</Label>
                        <Switch
                            id="showLegend"
                            checked={settings.showStats}
                            onCheckedChange={(checked) => updateSettings({ showStats: checked })}
                        />
                    </div>

                    <div className="flex items-center justify-between">
                        <Label htmlFor="showGrid">Show Histograms</Label>
                        <Switch
                            id="showGrid"
                            checked={settings.showHistograms}
                            onCheckedChange={(checked) => updateSettings({ showHistograms: checked })}
                        />
                    </div>

                    <div className="flex items-center justify-between">
                        <Label htmlFor="showGrid">Show Coincidence</Label>
                        <Switch
                            id="showGrid"
                            checked={settings.showCoincidence}
                            onCheckedChange={(checked) => updateSettings({ showCoincidence: checked })}
                        />
                    </div>

                    <div className="flex items-center justify-between">
                        <Label htmlFor="showGrid">Show Anticoincidence</Label>
                        <Switch
                            id="showGrid"
                            checked={settings.showAnticoincidence}
                            onCheckedChange={(checked) => updateSettings({ showAnticoincidence: checked })}
                        />
                    </div>

                    <div className="flex items-center justify-between">
                        <Label htmlFor="showGrid">Show Waveforms</Label>
                        <Switch
                            id="showGrid"
                            checked={settings.showWaveforms}
                            onCheckedChange={(checked) => updateSettings({ showWaveforms: checked })}
                        />
                    </div>


                </div>

                <div className="flex justify-end space-x-2">
                    <Button variant="outline" onClick={resetSettings}>
                        Reset to Defaults
                    </Button>
                    <Button onClick={() => toast({ title: 'Settings saved successfully' })}>
                        Save Changes
                    </Button>
                </div>
            </CardContent>
        </Card>
    )
}