'use client'

import { AuthGate } from '@/components/auth-gate'
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Layout } from '@/components/dashboard-layout';
import { PageHeader } from '@/components/page-header';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { VisualizationSettings } from '@/components/visualization-settings';
import { CurrentModuleSettings } from '@/components/current-module-settings';
import { NotificationSettings } from '@/components/notification-settings';
import { ElogSettings } from '@/components/elog/elog-settings';
import { MonitoringSettings } from '@/components/monitoring-settings';


// The sections, grouped by what they are about. Each says in one line what
// it is for, so the list reads as a map rather than a row of names.
const SECTIONS: { id: string; group: string; label: string; description: string; Component: React.ComponentType }[] = [
    { id: 'current', group: 'Hardware', label: 'Current module',
      description: 'The picoammeter that measures the beam current and charge', Component: CurrentModuleSettings },
    { id: 'monitoring', group: 'Services', label: 'Monitoring (Graphite, Grafana)',
      description: 'Where rates and beam current are written, metrics read, and alerts evaluated', Component: MonitoringSettings },
    { id: 'elog', group: 'Services', label: 'Logbook (ELOG)',
      description: 'Where run entries are posted', Component: ElogSettings },
    { id: 'notifications', group: 'Alerts', label: 'Notifications',
      description: 'Who is told, and how, when something goes wrong', Component: NotificationSettings },
    { id: 'appearance', group: 'Interface', label: 'Appearance',
      description: 'Theme, and which views the dashboard offers', Component: VisualizationSettings },
]
const GROUPS = Array.from(new Set(SECTIONS.map((s) => s.group)))
// Sections that were merged into another; old links and bookmarks land there.
const RENAMED: Record<string, string> = { graphite: 'monitoring', grafana: 'monitoring' }

function SettingsPageContent() {
    const router = useRouter();
    const [activeView, setActiveView] = useState('current');
    // Phones show either the list of sections or one section (with a way
    // back), like a phone's own settings app; a link to a section opens it.
    const [picked, setPicked] = useState(false);

    // Deep links to a section, e.g. /settings?view=current from the command
    // palette, and links between sections (the current module points at
    // Monitoring): followed whenever the query changes, not only on load.
    const viewParam = useSearchParams().get('view');
    useEffect(() => {
        // The boards are set up under Setup → Boards; old links still land there.
        if (viewParam === 'boards') { router.replace('/board'); return; }
        const view = viewParam ? (RENAMED[viewParam] ?? viewParam) : null;
        if (view && SECTIONS.some((s) => s.id === view)) { setActiveView(view); setPicked(true); }
    }, [router, viewParam]);

    // The section is in the URL too, so a reload or a shared link opens it.
    const selectView = (view: string) => {
        setActiveView(view);
        setPicked(true);
        window.scrollTo({ top: 0 });
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
                description="Instruments, services, notifications and how the pages look. The boards are set up under Boards and DAQ settings."
            />
            <div className="grid items-start gap-6 md:grid-cols-[220px_minmax(0,1fr)] lg:grid-cols-[260px_minmax(0,1fr)]">
                <nav aria-label="Settings sections" className={`gap-4 md:grid ${picked ? 'hidden' : 'grid'}`}>
                    {GROUPS.map((g) => (
                        <div key={g} className="grid gap-1">
                            <p className="px-2 text-xs font-semibold text-muted-foreground">{g}</p>
                            {SECTIONS.filter((s) => s.group === g).map((s) => {
                                const on = current.id === s.id
                                return (
                                    <button
                                        key={s.id}
                                        type="button"
                                        aria-current={on ? 'page' : undefined}
                                        onClick={() => selectView(s.id)}
                                        className={`flex items-center gap-2 rounded-md px-2 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-14 max-md:border max-md:bg-card ${
                                            on ? 'md:bg-primary/10' : 'hover:bg-muted'}`}
                                    >
                                        <span className="min-w-0 flex-1">
                                            <span className={`block text-sm font-medium ${on ? 'md:text-primary' : ''}`}>{s.label}</span>
                                            <span className="block text-xs text-muted-foreground">{s.description}</span>
                                        </span>
                                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground md:hidden" aria-hidden="true" />
                                    </button>
                                )
                            })}
                        </div>
                    ))}
                </nav>
                {/* min-w-0: a wide child (a table, a long path) scrolls
                    inside its own box instead of pushing the page sideways. */}
                <section aria-labelledby="settings-section-title" className={`min-w-0 gap-4 md:grid ${picked ? 'grid' : 'hidden'}`}>
                    <div>
                        <button
                            type="button"
                            onClick={() => setPicked(false)}
                            className="-ml-1 mb-2 inline-flex min-h-10 items-center gap-1 rounded-md px-1 text-sm text-muted-foreground hover:text-foreground md:hidden"
                        >
                            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                            All settings
                        </button>
                        <h2 id="settings-section-title" className="text-lg font-semibold">{current.label}</h2>
                        <p className="text-sm text-muted-foreground">{current.description}</p>
                    </div>
                    <div className="grid min-w-0 gap-6">
                        <Content />
                    </div>
                </section>
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
