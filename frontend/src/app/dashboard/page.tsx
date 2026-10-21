'use client';

import { useEffect, useMemo } from 'react';
import { AuthGate } from '@/components/auth-gate';
import { RunControl } from '@/components/run-control';
import dynamic from 'next/dynamic';
import { TabLoading } from '@/components/ui/tab-loading';

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
import { useActiveItem } from '@/components/app-nav';
import { PageHeader } from '@/components/page-header';
import {
  Tabs,
  TabsContent,
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

  const active = useActiveItem()

  return (
      <Layout>
        {/* The views are chosen from the sidebar (or the menu on a phone); the
            heading says which one this is. */}
        <PageHeader title={active?.label ?? 'Dashboard'} />
        <Tabs value={tab} onValueChange={setTab} orientation='vertical'>
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
