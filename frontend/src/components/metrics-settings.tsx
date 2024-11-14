'use client'

import { useState } from 'react'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Trash2, Eye, EyeOff } from 'lucide-react'
import { useMetricsStore } from '@/store/metrics-store'
import { toast } from '@/components/ui/use-toast'

export function MetricsSettings() {
    const { metrics, addMetric, removeMetric, updateMetric, toggleMetricVisibility } = useMetricsStore()
    const [newMetric, setNewMetric] = useState({
        entityName: '',
        metricName: '',
        unit: '',
        refreshInterval: 60,
        multiplier: '1'
    })

    const handleAddMetric = () => {
        if (newMetric.entityName && newMetric.metricName && newMetric.unit) {
            const parsedMultiplier = Number(newMetric.multiplier);
            if (isNaN(parsedMultiplier)) {
                toast({
                    title: "Invalid Multiplier",
                    description: "Please enter a valid number for the multiplier.",
                    variant: "destructive"
                });
                return;
            }
            
            const metricToAdd = {
                ...newMetric,
                multiplier: parsedMultiplier
            };
            addMetric(metricToAdd);
            setNewMetric({
                entityName: '',
                metricName: '',
                unit: '',
                refreshInterval: 60,
                multiplier: '1'
            });
            toast({
                title: "Metric Added",
                description: `${newMetric.metricName} has been added to your dashboard.`
            });
        }
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>Metrics Configuration</CardTitle>
                <CardDescription>Add and manage metrics to be shown in your dashboard.</CardDescription>
            </CardHeader>
            <CardContent>
                <div className="space-y-6">
                    {/* Add New Metric Form */}
                    <div className="space-y-4">
                        <div className="grid grid-cols-3 gap-4">
                            <div>
                                <Label htmlFor="entityName">Entity Name</Label>
                                <Input
                                    id="entityName"
                                    value={newMetric.entityName}
                                    onChange={(e) => setNewMetric({ ...newMetric, entityName: e.target.value })}
                                    placeholder="e.g., Server"
                                />
                            </div>
                            <div>
                                <Label htmlFor="metricName">Metric Name</Label>
                                <Input
                                    id="metricName"
                                    value={newMetric.metricName}
                                    onChange={(e) => setNewMetric({ ...newMetric, metricName: e.target.value })}
                                    placeholder="e.g., CPU Usage"
                                />
                            </div>
                            <div>
                                <Label htmlFor="unit">Unit</Label>
                                <Input
                                    id="unit"
                                    value={newMetric.unit}
                                    onChange={(e) => setNewMetric({ ...newMetric, unit: e.target.value })}
                                    placeholder="e.g., %"
                                />
                            </div>
                        </div>

                        <div>
                            <Label htmlFor="multiplier">Multiplier</Label>
                            <Input
                                id="multiplier"
                                value={newMetric.multiplier}
                                onChange={(e) => setNewMetric({ ...newMetric, multiplier: e.target.value })}
                                placeholder="e.g., 1.5 or 1e-6"
                            />
                        </div>

                        <div className="space-y-4">
                            <div>
                                <Label>Refresh Interval (seconds)</Label>
                                <Slider
                                    value={[newMetric.refreshInterval]}
                                    onValueChange={(value) => setNewMetric({ ...newMetric, refreshInterval: value[0] })}
                                    min={5}
                                    max={300}
                                    step={5}
                                    className="mt-2"
                                />
                                <div className="text-sm text-muted-foreground mt-1">
                                    {newMetric.refreshInterval} seconds
                                </div>
                            </div>
                        </div>

                        <Button onClick={handleAddMetric}>Add Metric</Button>
                    </div>

                    {/* Existing Metrics List */}
                    {metrics.length > 0 && (
                        <div className="mt-8">
                            <h3 className="text-lg font-semibold mb-4">Added Metrics</h3>
                            <div className="space-y-3">
                                {metrics.map((metric) => (
                                    <div key={metric.id} className="flex items-center justify-between p-3 bg-muted rounded-lg">
                                        <div className="flex items-center space-x-4">
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => toggleMetricVisibility(metric.id)}
                                            >
                                                {metric.isVisible ? (
                                                    <Eye className="h-4 w-4" />
                                                ) : (
                                                    <EyeOff className="h-4 w-4" />
                                                )}
                                            </Button>
                                            <div className="space-y-1">
                                                <div className="font-medium">
                                                    {metric.entityName} - {metric.metricName}
                                                </div>
                                                <div className="text-sm text-muted-foreground">
                                                    Unit: {metric.unit} | Refresh: {metric.refreshInterval}s |
                                                    Multiplier: {metric.multiplier}
                                                </div>
                                            </div>
                                        </div>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            onClick={() => {
                                                removeMetric(metric.id)
                                                toast({
                                                    title: "Metric Removed",
                                                    description: `${metric.metricName} has been removed from your dashboard.`
                                                })
                                            }}
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </CardContent>
        </Card>
    )
}