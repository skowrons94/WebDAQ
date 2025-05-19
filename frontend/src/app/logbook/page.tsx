'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react';
import useAuthStore from '@/store/auth-store';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/ui/use-toast';
import { Layout } from '@/components/dashboard-layout';
import {Logbook} from '@/components/logbook-table/logbook-page';

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
        <div className="container mx-auto px-0 py-0">
                    <div className="container mx-auto py-2">
                        <Logbook />
                    </div>
        </div>
        </Layout>
        </QueryClientProvider>
  )
}