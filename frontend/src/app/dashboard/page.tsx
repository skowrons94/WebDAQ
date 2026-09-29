'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import useAuthStore from '@/store/auth-store';
import { RunControl } from '@/components/run-control';
import BoardHealth from '@/components/board-health';
import RunStats from '@/components/run-stats';
import { Stats } from '@/components/stats';
import HistogramDashboard from '@/components/histo-dashboard';
import WaveformDashboard from '@/components/wave-dashboard';
import PSDDashboard from '@/components/psd-dashboard';
import { Layout } from '@/components/dashboard-layout';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { useVisualizationStore } from '@/store/visualization-settings-store'
import { useDashboardTabStore } from '@/store/dashboard-tab-store'


const queryClient = new QueryClient()

export default function DashboardPage() {
  const token = useAuthStore((state) => state.token);
  const { settings } = useVisualizationStore()
  const router = useRouter();
  // Shared with the command palette, so a jump to a tab works from this page too.
  const tab = useDashboardTabStore((state) => state.tab)
  const setTab = useDashboardTabStore((state) => state.setTab)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (mounted && !token) {
      router.push('/auth/login');
    }
  }, [mounted, token, router]);

  // Which tabs exist right now. A ?tab= naming a view that is switched off in
  // Appearance would otherwise select a tab with no trigger and no content, and
  // the page body would simply be empty.
  const availableTabs = useMemo(() => [
    'overview', 'health', 'runstats',
    ...(settings.showHistograms ? ['histograms'] : []),
    ...(settings.showWaveforms ? ['waveforms'] : []),
    ...((settings.showPSD ?? true) ? ['psd'] : []),
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

  if (!mounted || !token) {
    return null;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <Layout>
        <Tabs value={tab} onValueChange={setTab} orientation='vertical'>
          <div className="flex max-w-full items-center overflow-x-auto pb-1">
            <TabsList className="min-w-max">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                  {/* The boards' own health sits beside the overview: during a run
                      it answers the question the overview raises. */}
                  <TabsTrigger value="health">Board Health</TabsTrigger>
                {/* Rates come right after the overview: during a run they are
                    what tells you the detectors are alive, so they are looked at
                    far more often than the spectra. */}
                <TabsTrigger value="runstats">Data Rates</TabsTrigger>
                {settings.showHistograms && <TabsTrigger value="histograms">Histograms</TabsTrigger>}
                {settings.showWaveforms && <TabsTrigger value="waveforms">Waveforms</TabsTrigger>}
                {(settings.showPSD ?? true) && <TabsTrigger value="psd">PSD</TabsTrigger>}
              </TabsList>
            </div>
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
        </Tabs>
      </Layout>
    </QueryClientProvider>
  );
}
