'use client';

import { AuthGate } from '@/components/auth-gate'
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



function DaqPageContent() {
  const { settings } = useVisualizationStore()

  return (
    <>
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
    </>
  );
}

// AuthGate: rendered only after hydration and only with a token (see
// components/auth-gate.tsx); it also provides the app's one QueryClient.
export default function DashboardPage() {
    return (
        <AuthGate>
            <DaqPageContent />
        </AuthGate>
    )
}
