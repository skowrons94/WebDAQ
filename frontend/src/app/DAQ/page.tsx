'use client';

import { AuthGate } from '@/components/auth-gate'
import CAENDashboard from '@/components/caen-dashboard';
import BoardInfoPanel from '@/components/board-info';
import { Layout } from '@/components/dashboard-layout'; import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { PageHeader } from '@/components/page-header'



function DaqPageContent() {
  return (
    <>
      <Layout>
        {/* Energy calibration lives on the histogram cards (the ruler button). */}
        <PageHeader title="DAQ settings" description="Board registers, channel settings and synchronisation." />
        <Tabs defaultValue="caen" orientation='vertical'>
            <div className="flex items-center">
            <TabsList>
                <TabsTrigger value="caen">Configuration</TabsTrigger>
                <TabsTrigger value="hardware">Hardware info</TabsTrigger>
              </TabsList>
            </div>
          <TabsContent value="caen">
            <CAENDashboard />
          </TabsContent>
          <TabsContent value="hardware">
            <BoardInfoPanel />
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
