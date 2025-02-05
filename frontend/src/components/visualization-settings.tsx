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
                    Customize how the main dashboard is displayed
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">

                <div className="grid gap-4">

                    <p className="text-lg font-bold">General settings</p>
                    <div className="space-y-2 p-2">
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
                    <p className="text-xl font-bold">Show/Hide tabs</p>
                    <div className="flex items-center justify-between p-2">
                        <Label htmlFor="showStats">Show Stats</Label>
                        <Switch
                            id="showStats"
                            checked={settings.showStats}
                            onCheckedChange={(checked) => updateSettings({ showStats: checked })}
                        />
                    </div>

                    <div className="flex items-center justify-between p-2">
                        <Label htmlFor="showHistograms">Show Histograms</Label>
                        <Switch
                            id="showHistograms"
                            checked={settings.showHistograms}
                            onCheckedChange={(checked) => updateSettings({ showHistograms: checked })}
                        />
                    </div>

                    <div className="flex items-center justify-between p-2">
                        <Label htmlFor="showWaveforms">Show Waveforms</Label>
                        <Switch
                            id="showWaveforms"
                            checked={settings.showWaveforms}
                            onCheckedChange={(checked) => updateSettings({ showWaveforms: checked })}
                        />
                    </div>
                    <p className="text-lg font-bold">Show/Hide cards in dashboard</p>

                    <div className="flex items-center justify-between p-2">
                        <Label htmlFor="showStatus">Show Run status</Label>
                        <Switch
                            id="showStatus"
                            checked={settings.showStatus}
                            onCheckedChange={(checked) => updateSettings({ showStatus: checked })}
                        />
                    </div>
                    <div className="flex items-center justify-between p-2">
                        <Label htmlFor="showCurrent">Show Current and Accumulated charge</Label>
                        <Switch
                            id="showCurrent"
                            checked={settings.showCurrent}
                            onCheckedChange={(checked) => updateSettings({ showCurrent: checked })}
                        />
                    </div>
                    <div className="flex items-center justify-between p-2">
                        <Label htmlFor="showXDAQ">Show XDAQ metrics</Label>
                        <Switch
                            id="showXDAQ"
                            checked={settings.showXDAQ}
                            onCheckedChange={(checked) => updateSettings({ showXDAQ: checked })}
                        />
                    </div>
                    <div className="flex items-center justify-between p-2">
                        <Label htmlFor="showROIs">Show Monitored ROIs</Label>
                        <Switch
                            id="showROIs"
                            checked={settings.showROIs}
                            onCheckedChange={(checked) => updateSettings({ showROIs: checked })}
                        />
                    </div>
                    <div className="flex items-center justify-between p-2">
                        <Label htmlFor="showMetrics">Show Monitored Metrics</Label>
                        <Switch
                            id="showMetrics"
                            checked={settings.showMetrics}
                            onCheckedChange={(checked) => updateSettings({ showMetrics: checked })}
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