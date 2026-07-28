'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react';
import useAuthStore from '@/store/auth-store';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/ui/use-toast';
import { Layout } from '@/components/dashboard-layout';
import {Logbook} from '@/components/logbook-table/logbook-page';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ElogPanel } from '@/components/elog/elog-panel';

const queryClient = new QueryClient()

export default  function LogbookPage() {
    const router = useRouter();
    const token = useAuthStore((state) => state.token);
    const clearToken = useAuthStore((state) => state.clearToken);
    const { toast } = useToast()

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
        </QueryClientProvider>
    )
}