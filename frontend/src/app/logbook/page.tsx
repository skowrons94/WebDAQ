'use client'

import { AuthGate } from '@/components/auth-gate'
import { Layout } from '@/components/dashboard-layout';
import {Logbook} from '@/components/logbook-table/logbook-page';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ElogPanel } from '@/components/elog/elog-panel';
import { PageHeader } from '@/components/page-header';


function LogbookPageContent() {
    

    return (
        <>
            <Layout>
                <PageHeader
                    title="Logbook"
                    description="Every run with its name, charge and notes. Open a run number for its full entry."
                />
                {/* Two logbooks live here: the run metadata WebDAQ records itself,
                    and the collaboration's ELOG. */}
                <Tabs defaultValue="runs" className="space-y-4">
                    <TabsList>
                        <TabsTrigger value="runs">Runs</TabsTrigger>
                        <TabsTrigger value="elog">ELOG</TabsTrigger>
                    </TabsList>
                    <TabsContent value="runs">
                        <Logbook />
                    </TabsContent>
                    <TabsContent value="elog">
                        <ElogPanel />
                    </TabsContent>
                </Tabs>
            </Layout>
        </>
    )
}

// AuthGate: rendered only after hydration and only with a token (see
// components/auth-gate.tsx); it also provides the app's one QueryClient.
export default function LogbookPage() {
    return (
        <AuthGate>
            <LogbookPageContent />
        </AuthGate>
    )
}
