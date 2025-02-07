'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import useAuthStore from '@/store/auth-store';
import { RunControl } from '@/components/run-control';
import { Stats } from '@/components/stats';
import HistogramDashboard from '@/components/histo-dashboard';
import WaveformDashboard from '@/components/wave-dashboard';
import { Layout } from '@/components/dashboard-layout'; import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { useVisualizationStore } from '@/store/visualization-settings-store'
import CurrentGraph from "@/components/current-graph"


const queryClient = new QueryClient()

export default function DashboardPage() {
  const token = useAuthStore((state) => state.token);
  const { settings } = useVisualizationStore()
  const router = useRouter();

  useEffect(() => {
    if (!token) {
      router.push('/auth/login');
    }
  }, [token, router]);

  if (!token) {
    return null;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <Layout>
        <Tabs defaultValue="overview" orientation='vertical'>        
            <div className="flex items-center">
            <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                {settings.showStats && <TabsTrigger value="stats">Stats</TabsTrigger>}
                {settings.showHistograms && <TabsTrigger value="histograms">Histograms</TabsTrigger>}
                {settings.showWaveforms && <TabsTrigger value="waveforms">Waveforms</TabsTrigger>}
              </TabsList>
            </div>
          <TabsContent value="overview">
            <RunControl />
            <CurrentGraph />
          </TabsContent>
          <TabsContent value="stats">
            <Stats />
          </TabsContent>
          <TabsContent value="histograms">
            <HistogramDashboard />
          </TabsContent>
          <TabsContent value="waveforms">
            <WaveformDashboard />
          </TabsContent>
        </Tabs>
      </Layout>
    </QueryClientProvider>
  );
}
