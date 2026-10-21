'use client';

import { useEffect, useMemo } from 'react';
import { AuthGate } from '@/components/auth-gate';
import { RunControl } from '@/components/run-control';
import dynamic from 'next/dynamic';
import { TabLoading } from '@/components/ui/tab-loading';
import { ScrollFade } from '@/components/ui/scroll-fade';

// The overview is what opens; every other tab (recharts, dnd-kit, the JSROOT
// dashboards) is loaded when first shown, which keeps /dashboard's first load
// small on a phone or a slow control-room link.
const BoardHealth = dynamic(() => import('@/components/board-health'), { ssr: false, loading: TabLoading });
const RunStats = dynamic(() => import('@/components/run-stats'), { ssr: false, loading: TabLoading });
const HistogramDashboard = dynamic(() => import('@/components/histo-dashboard'), { ssr: false, loading: TabLoading });
const WaveformDashboard = dynamic(() => import('@/components/wave-dashboard'), { ssr: false, loading: TabLoading });
const PSDDashboard = dynamic(() => import('@/components/psd-dashboard'), { ssr: false, loading: TabLoading });
const CoincidencesDashboard = dynamic(() => import('@/components/coincidences-dashboard'), { ssr: false, loading: TabLoading });
import { Layout } from '@/components/dashboard-layout';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { useVisualizationStore } from '@/store/visualization-settings-store'
import { useDashboardTabStore } from '@/store/dashboard-tab-store'

function DashboardContent() {
  const { settings } = useVisualizationStore()
  // Shared with the command palette, so a jump to a tab works from this page too.
  const tab = useDashboardTabStore((state) => state.tab)
  const setTab = useDashboardTabStore((state) => state.setTab)

  // Which tabs exist right now. A ?tab= naming a view that is switched off in
  // Appearance would otherwise select a tab with no trigger and no content, and
  // the page body would simply be empty.
  const availableTabs = useMemo(() => [
    'overview', 'health', 'runstats',
    ...(settings.showHistograms ? ['histograms'] : []),
    ...(settings.showWaveforms ? ['waveforms'] : []),
    ...((settings.showPSD ?? true) ? ['psd'] : []),
    'coincidences',
  ], [settings.showHistograms, settings.showWaveforms, settings.showPSD]);

  // Honor a ?tab= query param, for a bookmark or a link from outside the app.
  // Read on the client to avoid a Suspense boundary.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab')
    if (t && availableTabs.includes(t)) setTab(t)
  }, [availableTabs, setTab]);

  // A tab whose view has just been switched off must not leave a blank page.
  useEffect(() => {
    if (!availableTabs.includes(tab)) setTab('overview')
  }, [availableTabs, tab, setTab]);

  return (
      <Layout>
        <Tabs value={tab} onValueChange={setTab} orientation='vertical'>
          {/* A fade at the cut edge, so a phone's strip (cut at "Histogra")
              says there are more tabs; the padding lets the last one clear it. */}
          <ScrollFade className="max-w-full" innerClassName="flex items-center pb-1 max-sm:pr-8">
            <TabsList className="min-w-max">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                  {/* The boards' own health sits beside the overview: during a run
                      it answers the question the overview raises. */}
                  <TabsTrigger value="health">Board health</TabsTrigger>
                {/* Rates come right after the overview: during a run they are
                    what tells you the detectors are alive, so they are looked at
                    far more often than the spectra. */}
                <TabsTrigger value="runstats">Data rates</TabsTrigger>
                {settings.showHistograms && <TabsTrigger value="histograms">Histograms</TabsTrigger>}
                {settings.showWaveforms && <TabsTrigger value="waveforms">Waveforms</TabsTrigger>}
                {(settings.showPSD ?? true) && <TabsTrigger value="psd">PSD</TabsTrigger>}
                <TabsTrigger value="coincidences">Coincidences</TabsTrigger>
              </TabsList>
            </ScrollFade>
          <TabsContent value="health">
              <BoardHealth />
            </TabsContent>
          <TabsContent value="overview">
            <RunControl />
          </TabsContent>
          {settings.showHistograms && (
            <TabsContent value="histograms">
              <HistogramDashboard />
            </TabsContent>
          )}
          {settings.showWaveforms && (
            <TabsContent value="waveforms">
              <WaveformDashboard />
            </TabsContent>
          )}
          {(settings.showPSD ?? true) && (
            <TabsContent value="psd">
              <PSDDashboard />
            </TabsContent>
          )}
          <TabsContent value="runstats">
            <RunStats />
          </TabsContent>
          <TabsContent value="coincidences">
            <CoincidencesDashboard />
          </TabsContent>
        </Tabs>
      </Layout>
  );
}

// AuthGate renders the dashboard only after hydration and with a token
// (components/auth-gate.tsx); it replaces the page's own mounted flag.
export default function DashboardPage() {
  return (
    <AuthGate>
      <DashboardContent />
    </AuthGate>
  )
}
