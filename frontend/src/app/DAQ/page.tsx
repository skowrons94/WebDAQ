'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import useAuthStore from '@/store/auth-store';
import CalibrationDashboard from '@/components/calib-dashboard';
import CAENDashboard from '@/components/caen-dashboard';
import BoardInfoPanel from '@/components/board-info';
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
        <Tabs defaultValue="caen" orientation='vertical'>        
            <div className="flex items-center">
            <TabsList>
                <TabsTrigger value="caen">Configuration</TabsTrigger>
                <TabsTrigger value="calibration">Calibration</TabsTrigger>
                <TabsTrigger value="hardware">Hardware Info</TabsTrigger>
              </TabsList>
            </div>
          <TabsContent value="caen">
            <CAENDashboard />
          </TabsContent>
          <TabsContent value="calibration">
            <CalibrationDashboard />
          </TabsContent>
          <TabsContent value="hardware">
            <div className="container mx-auto p-4">
              <BoardInfoPanel />
            </div>
          </TabsContent>
        </Tabs>
      </Layout>
    </QueryClientProvider>
  );
}
