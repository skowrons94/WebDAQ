'use client'

import { AuthGate } from '@/components/auth-gate'
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Layout } from '@/components/dashboard-layout';
import { PageHeader } from '@/components/page-header';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { VisualizationSettings } from '@/components/visualization-settings';
import { CurrentModuleSettings } from '@/components/current-module-settings';
import { NotificationSettings } from '@/components/notification-settings';
import { ElogSettings } from '@/components/elog/elog-settings';
import { GrafanaSettings } from '@/components/grafana-settings';
import { GraphiteSettings } from '@/components/graphite-settings';


// The sections, grouped by what they are about. Each says in one line what
// it is for, so the list reads as a map rather than a row of names.
const SECTIONS: { id: string; group: string; label: string; description: string; Component: React.ComponentType }[] = [
    { id: 'current', group: 'Hardware', label: 'Current module',
      description: 'The picoammeter that measures the beam current and charge', Component: CurrentModuleSettings },
    { id: 'graphite', group: 'Services', label: 'Statistics (Graphite)',
      description: 'Where rates are written and accelerator metrics read', Component: GraphiteSettings },
    { id: 'grafana', group: 'Services', label: 'Grafana',
      description: 'Dashboards and the alert rules they evaluate', Component: GrafanaSettings },
    { id: 'elog', group: 'Services', label: 'Logbook (ELOG)',
      description: 'Where run entries are posted', Component: ElogSettings },
    { id: 'notifications', group: 'Alerts', label: 'Notifications',
      description: 'Who is told, and how, when something goes wrong', Component: NotificationSettings },
    { id: 'appearance', group: 'Interface', label: 'Appearance',
      description: 'Theme, and which views the dashboard offers', Component: VisualizationSettings },
]
const GROUPS = Array.from(new Set(SECTIONS.map((s) => s.group)))

function SettingsPageContent() {
    const router = useRouter();
    const [activeView, setActiveView] = useState('current');

    // Deep links to a section, e.g. /settings?view=current from the command
    // palette, and links between sections (the two Graphite cards point at
    // each other): followed whenever the query changes, not only on load.
    const viewParam = useSearchParams().get('view');
    useEffect(() => {
        // The boards are set up under Setup → Boards; old links still land there.
        if (viewParam === 'boards') { router.replace('/board'); return; }
        if (viewParam && SECTIONS.some((s) => s.id === viewParam)) setActiveView(viewParam);
    }, [router, viewParam]);

    // The section is in the URL too, so a reload or a shared link opens it.
    const selectView = (view: string) => {
        setActiveView(view);
        const url = new URL(window.location.href);
        url.searchParams.set('view', view);
        window.history.replaceState(null, '', url.toString());
    };

    const current = SECTIONS.find((s) => s.id === activeView) ?? SECTIONS[0];
    const Content = current.Component;

    return (
        <Layout>
            <PageHeader
                title="Settings"
                description="How this DAQ reaches its instruments and services, who it tells when something goes wrong, and how it looks. The boards themselves are set up under Setup → Boards and DAQ settings."
            />
            <div className="grid w-full gap-6">
                <div className="grid items-start gap-6 md:grid-cols-[220px_minmax(0,1fr)] lg:grid-cols-[260px_minmax(0,1fr)]">
                    {/* Phones: one select instead of a list that pushes the
                        section a screen down. */}
                    <div className="md:hidden">
                        <Label htmlFor="settings-section" className="sr-only">Settings section</Label>
                        <Select value={current.id} onValueChange={selectView}>
                            <SelectTrigger id="settings-section"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {GROUPS.map((g) => (
                                    <SelectGroup key={g}>
                                        <SelectLabel>{g}</SelectLabel>
                                        {SECTIONS.filter((s) => s.group === g).map((s) => (
                                            <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>
                                        ))}
                                    </SelectGroup>
                                ))}
                            </SelectContent>
                        </Select>
                        <p className="mt-2 text-xs text-muted-foreground">{current.description}</p>
                    </div>
                    <nav aria-label="Settings sections" className="hidden gap-4 md:grid">
                        {GROUPS.map((g) => (
                            <div key={g} className="grid gap-1">
                                <p className="px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{g}</p>
                                {SECTIONS.filter((s) => s.group === g).map((s) => (
                                    <button
                                        key={s.id}
                                        type="button"
                                        aria-current={current.id === s.id ? 'page' : undefined}
                                        onClick={() => selectView(s.id)}
                                        className={`rounded-md px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                                            current.id === s.id ? 'bg-primary/10' : 'hover:bg-muted'}`}
                                    >
                                        <span className={`block text-sm font-medium ${current.id === s.id ? 'text-primary' : ''}`}>{s.label}</span>
                                        <span className="block text-xs text-muted-foreground">{s.description}</span>
                                    </button>
                                ))}
                            </div>
                        ))}
                    </nav>
                    {/* min-w-0: a wide child (a table, a long path) scrolls
                        inside its own box instead of pushing the page sideways. */}
                    <div className="grid min-w-0 gap-6">
                        <Content />
                    </div>
                </div>
            </div>
        </Layout>
    )
}

// AuthGate: rendered only after hydration and only with a token (see
// components/auth-gate.tsx); it also provides the app's one QueryClient.
export default function SettingsPage() {
    return (
        <AuthGate>
            <Suspense fallback={null}>
                <SettingsPageContent />
            </Suspense>
        </AuthGate>
    )
}
