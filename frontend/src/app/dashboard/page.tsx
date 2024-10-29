'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import useAuthStore from '@/store/auth-store';
import { RunControl } from '@/components/run-control';
import { Stats } from '@/components/stats';
import HistogramDashboard from '@/components/histo-dashboard';
import WaveformDashboard from '@/components/wave-dashboard';
import CalibrationDashboard from '@/components/calib-dashboard';
import AntiCoincidenceDashboard from '@/components/anti-dashboard';
import CoincidenceDashboard from '@/components/coin-dashboard';
import CAENDashboard from '@/components/caen-dashboard';
import { Layout } from '@/components/dashboard-layout'; import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useVisualizationStore } from '@/store/visualization-settings-store'


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
        <Tabs defaultValue="overview">        
            <div className="flex items-center">
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                {settings.showStats && <TabsTrigger value="stats">Stats</TabsTrigger>}
                {settings.showHistograms && <TabsTrigger value="histograms">Histograms</TabsTrigger>}
                {settings.showCoincidence && <TabsTrigger value="coincidence">Coincidence</TabsTrigger>}
                {settings.showAnticoincidence && <TabsTrigger value="anticoincidence">Anticoincidence</TabsTrigger>}
                {settings.showWaveforms && <TabsTrigger value="waveforms">Waveforms</TabsTrigger>}
                <TabsTrigger value="caen">CAEN</TabsTrigger>
                <TabsTrigger value="calibration">Calibration</TabsTrigger>
              </TabsList>
            </div>
          <TabsContent value="overview">
            <RunControl />
          </TabsContent>
          <TabsContent value="caen">
            <CAENDashboard />
          </TabsContent>
          <TabsContent value="stats">
            <Stats />
          </TabsContent>
          <TabsContent value="histograms">
            <HistogramDashboard />
          </TabsContent>
          <TabsContent value="coincidence">
            <CoincidenceDashboard />
          </TabsContent>
          <TabsContent value="anticoincidence">
            <AntiCoincidenceDashboard />
          </TabsContent>
          <TabsContent value="waveforms">
            <WaveformDashboard />
          </TabsContent>
          <TabsContent value="calibration">
            <CalibrationDashboard />
          </TabsContent>
        </Tabs>
      </Layout>
    </QueryClientProvider>
  );
}

function MoonStarIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9" />
      <path d="M20 3v4" />
      <path d="M22 5h-4" />
    </svg>
  )
}