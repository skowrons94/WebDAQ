'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import useAuthStore from '@/store/auth-store';
import { RunControl } from '@/components/run-control';
import RunStats from '@/components/run-stats';
import { Stats } from '@/components/stats';
import HistogramDashboard from '@/components/histo-dashboard';
import WaveformDashboard from '@/components/wave-dashboard';
import PSDDashboard from '@/components/psd-dashboard';
import { Layout } from '@/components/dashboard-layout'; import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { useVisualizationStore } from '@/store/visualization-settings-store'


const queryClient = new QueryClient()

export default function DashboardPage() {
  const token = useAuthStore((state) => state.token);
  const { settings } = useVisualizationStore()
  const router = useRouter();
  const [tab, setTab] = useState('overview')

  useEffect(() => {
    if (!token) {
      router.push('/auth/login');
    }
  }, [token, router]);

  // Honor a ?tab= query param (used by the command palette to jump straight to
  // Histograms / Waveforms). Read on the client to avoid a Suspense boundary.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab')
    if (t) setTab(t)
  }, []);

  if (!token) {
    return null;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <Layout>
        <Tabs value={tab} onValueChange={setTab} orientation='vertical'>
            <div className="flex items-center">
            <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                {/* Rates come right after the overview: during a run they are
                    what tells you the detectors are alive, so they are looked at
                    far more often than the spectra. */}
                <TabsTrigger value="runstats">Data Rates</TabsTrigger>
                {settings.showHistograms && <TabsTrigger value="histograms">Histograms</TabsTrigger>}
                {settings.showWaveforms && <TabsTrigger value="waveforms">Waveforms</TabsTrigger>}
                {(settings.showPSD ?? true) && <TabsTrigger value="psd">PSD</TabsTrigger>}
              </TabsList>
            </div>
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
