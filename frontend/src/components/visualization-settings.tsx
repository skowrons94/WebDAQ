import { useVisualizationStore } from '@/store/visualization-settings-store'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { useTheme } from 'next-themes'

export function VisualizationSettings() {
    const { settings, updateSettings, resetSettings } = useVisualizationStore()
    const { toast } = useToast()
    const { setTheme } = useTheme()

    return (
        // No card title: the section heading above ("Appearance") says it.
        <Card>
            <CardContent className="space-y-6 pt-6">

                <div className="grid gap-4">

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
                    <div className="flex items-center justify-between p-2">
                        <div className="flex flex-col">
                            <Label htmlFor="currentEnabled">Enable current acquisition</Label>
                            <span className="text-xs text-muted-foreground">
                                When off, the current plot, device card and charge cards are hidden and the picoammeter is not started with a run
                            </span>
                        </div>
                        <Switch
                            id="currentEnabled"
                            aria-label="Enable current acquisition"
                            checked={settings.currentEnabled !== false}
                            onCheckedChange={(checked) => updateSettings({ currentEnabled: checked })}
                        />
                    </div>
                    <h3 className="px-2 pt-2 text-base font-semibold">Dashboard views</h3>
                    <div className="flex items-center justify-between p-2">
                        <Label htmlFor="showStats">Show stats</Label>
                        <Switch
                            id="showStats"
                            aria-label="Show stats"
                            checked={settings.showStats}
                            onCheckedChange={(checked) => updateSettings({ showStats: checked })}
                        />
                    </div>

                    <div className="flex items-center justify-between p-2">
                        <Label htmlFor="showHistograms">Show histograms</Label>
                        <Switch
                            id="showHistograms"
                            aria-label="Show histograms"
                            checked={settings.showHistograms}
                            onCheckedChange={(checked) => updateSettings({ showHistograms: checked })}
                        />
                    </div>

                    <div className="flex items-center justify-between p-2">
                        <Label htmlFor="showWaveforms">Show waveforms</Label>
                        <Switch
                            id="showWaveforms"
                            aria-label="Show waveforms"
                            checked={settings.showWaveforms}
                            onCheckedChange={(checked) => updateSettings({ showWaveforms: checked })}
                        />
                    </div>

                    <div className="flex items-center justify-between p-2">
                        <Label htmlFor="showPSD">Show PSD</Label>
                        <Switch
                            id="showPSD"
                            aria-label="Show PSD"
                            checked={settings.showPSD ?? true}
                            onCheckedChange={(checked) => updateSettings({ showPSD: checked })}
                        />
                    </div>
                    <h3 className="px-2 pt-2 text-base font-semibold">Overview cards</h3>

                    <div className="flex items-center justify-between p-2">
                        <Label htmlFor="showStatus">Show run status</Label>
                        <Switch
                            id="showStatus"
                            aria-label="Show run status"
                            checked={settings.showStatus}
                            onCheckedChange={(checked) => updateSettings({ showStatus: checked })}
                        />
                    </div>
                    <div className="flex items-center justify-between p-2">
                        <Label htmlFor="showCurrent">Show current and accumulated charge</Label>
                        <Switch
                            id="showCurrent"
                            aria-label="Show current and accumulated charge"
                            checked={settings.showCurrent}
                            onCheckedChange={(checked) => updateSettings({ showCurrent: checked })}
                        />
                    </div>
                    <div className="flex items-center justify-between p-2">
                        <Label htmlFor="showROIs">Show monitored ROIs</Label>
                        <Switch
                            id="showROIs"
                            aria-label="Show monitored ROIs"
                            checked={settings.showROIs}
                            onCheckedChange={(checked) => updateSettings({ showROIs: checked })}
                        />
                    </div>
                    <div className="flex items-center justify-between p-2">
                        <Label htmlFor="showMetrics">Show monitored metrics</Label>
                        <Switch
                            id="showMetrics"
                            aria-label="Show monitored metrics"
                            checked={settings.showMetrics}
                            onCheckedChange={(checked) => updateSettings({ showMetrics: checked })}
                        />
                    </div>
                </div>

                <div className="flex justify-end space-x-2">
                    <Button variant="outline" onClick={resetSettings}>
                        Reset to defaults
                    </Button>
                    <Button onClick={() => toast({ title: 'Settings saved successfully' })}>
                        Save changes
                    </Button>
                </div>
            </CardContent>
        </Card>
    )
}