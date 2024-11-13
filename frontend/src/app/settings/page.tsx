'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react';
import { Logbook } from '@/components/logbook'
import useAuthStore from '@/store/auth-store';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/ui/use-toast';
import { Layout } from '@/components/dashboard-layout';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { Checkbox } from '@/components/ui/checkbox';
import { Board } from '@/components/board';
import { JsonEditor } from '@/components/json';
import { VisualizationSettings } from '@/components/visualization-settings';
import { MetricsSettings } from '@/components/metrics-settings'

const queryClient = new QueryClient()

export default function SettingsPage() {
    const router = useRouter();
    const token = useAuthStore((state) => state.token);
    const clearToken = useAuthStore((state) => state.clearToken);
    const { toast } = useToast()
    const [activeView, setActiveView] = useState('general');

    useEffect(() => {
        if (!token) {
            router.push('/auth/login');
        }
    }, [token, router]);

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
            case 'json':
                return <JsonEditor />;
            case 'metrics':
                return <MetricsSettings />;
            default:
                return (
                    < VisualizationSettings />
                );
        }
    };

    return (
        <QueryClientProvider client={queryClient}>
            <Layout>
                <main className="flex min-h-[calc(100vh_-_theme(spacing.16))] flex-1 flex-col gap-4 bg-muted/40 p-4 md:gap-8 md:p-10 rounded-lg border">
                    <div className="mx-auto grid w-full max-w-6xl gap-2">
                        <h1 className="text-3xl font-semibold">Settings</h1>
                    </div>
                    <div className="mx-auto grid w-full max-w-6xl items-start gap-6 md:grid-cols-[180px_1fr] lg:grid-cols-[250px_1fr]">
                        <nav className="grid gap-4 text-sm text-muted-foreground">
                            <Link
                                href="#"
                                className={`font-semibold ${activeView === 'appearance' ? 'text-primary' : ''}`}
                                onClick={() => setActiveView('appearance')}
                            >
                                Appearance
                            </Link>
                            <Link
                                href="#"
                                className={`font-semibold ${activeView === 'boards' ? 'text-primary' : ''}`}
                                onClick={() => setActiveView('boards')}
                            >
                                Boards
                            </Link>
                            <Link
                                href="#"
                                className={`font-semibold ${activeView === 'json' ? 'text-primary' : ''}`}
                                onClick={() => setActiveView('json')}
                            >
                                Caen JSON editor
                            </Link>
                            <Link
                                href="#"
                                className={`font-semibold ${activeView === 'metrics' ? 'text-primary' : ''}`}
                                onClick={() => setActiveView('metrics')}
                            >
                                Metrics
                            </Link>
                            
                        </nav>
                        <div className="grid gap-6">
                            {renderActiveView()}
                        </div>
                    </div>
                </main>
            </Layout>
        </QueryClientProvider>
    )
}