'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react';
import useAuthStore from '@/store/auth-store';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/ui/use-toast';
import { Layout } from '@/components/dashboard-layout';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Board } from '@/components/board';
import { VisualizationSettings } from '@/components/visualization-settings';
import { CurrentModuleSettings } from '@/components/current-module-settings';
import { NotificationSettings } from '@/components/notification-settings';
import { ElogSettings } from '@/components/elog/elog-settings';
import { GrafanaSettings } from '@/components/grafana-settings';

const queryClient = new QueryClient()

export default function SettingsPage() {
    const router = useRouter();
    const token = useAuthStore((state) => state.token);
    const clearToken = useAuthStore((state) => state.clearToken);
    const { toast } = useToast()
    const [activeView, setActiveView] = useState('boards');

    useEffect(() => {
        if (!token) {
            router.push('/auth/login');
        }
    }, [token, router]);

    // Allow deep-linking to a section, e.g. /settings?view=current from the
    // command palette. Read from the URL on the client to avoid needing a
    // Suspense boundary around useSearchParams.
    useEffect(() => {
        const view = new URLSearchParams(window.location.search).get('view');
        if (view && ['appearance', 'boards', 'current', 'notifications', 'elog', 'grafana'].includes(view)) {
            setActiveView(view);
        }
    }, []);

    const handleLogout = () => {
        clearToken();
        router.push('/');
    };

    if (!token) {
        return null;
    }

    const renderActiveView = () => {
        switch (activeView) {
            case 'appearance':
                return < VisualizationSettings />;
            case 'boards':
                return <Board />;
            case 'current':
                return <CurrentModuleSettings />;
            case 'notifications':
                return <NotificationSettings />;
            case 'elog':
                return <ElogSettings />;
            case 'grafana':
                return <GrafanaSettings />;
            default:
                return (
                    < VisualizationSettings />
                );
        }
    };

    const VIEWS: { id: string; label: string }[] = [
        { id: 'boards', label: 'Boards' },
        { id: 'current', label: 'Current module' },
        { id: 'notifications', label: 'Notifications' },
        { id: 'elog', label: 'ELOG' },
        { id: 'grafana', label: 'Grafana' },
        { id: 'appearance', label: 'Appearance' },
    ];

    // The section is in the URL too, so a reload or a shared link opens it.
    const selectView = (view: string) => {
        setActiveView(view);
        const url = new URL(window.location.href);
        url.searchParams.set('view', view);
        window.history.replaceState(null, '', url.toString());
    };

    return (
        <QueryClientProvider client={queryClient}>
            <Layout>
                <div className="flex min-h-[calc(100vh_-_theme(spacing.16))] flex-1 flex-col gap-4 rounded-lg border bg-muted/40 p-3 sm:p-4 md:gap-8 md:p-10">
                    <div className="mx-auto grid w-full max-w-6xl gap-2">
                        <h1 className="text-2xl font-semibold">Settings</h1>
                    </div>
                    <div className="mx-auto grid w-full max-w-6xl items-start gap-6 md:grid-cols-[180px_minmax(0,1fr)] lg:grid-cols-[250px_minmax(0,1fr)]">
                        {/* Phones: one select instead of a list that pushes the
                            section a screen down. */}
                        <div className="md:hidden">
                            <Label htmlFor="settings-section" className="sr-only">Settings section</Label>
                            <Select value={activeView} onValueChange={selectView}>
                                <SelectTrigger id="settings-section" className="bg-background">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {VIEWS.map((v) => (
                                        <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <nav aria-label="Settings sections" className="hidden gap-1 text-sm md:grid">
                            {VIEWS.map((v) => (
                                <button
                                    key={v.id}
                                    type="button"
                                    aria-current={activeView === v.id ? 'page' : undefined}
                                    onClick={() => selectView(v.id)}
                                    className={`rounded-md px-2 py-2 text-left font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                                        activeView === v.id
                                            ? 'bg-background text-primary shadow-sm'
                                            : 'text-muted-foreground hover:text-foreground'
                                    }`}
                                >
                                    {v.label}
                                </button>
                            ))}
                        </nav>
                        {/* min-w-0: a wide child (a table, a long path) scrolls
                            inside its own box instead of pushing the page sideways. */}
                        <div className="grid min-w-0 gap-6">
                            {renderActiveView()}
                        </div>
                    </div>
                </div>
            </Layout>
        </QueryClientProvider>
    )
}
