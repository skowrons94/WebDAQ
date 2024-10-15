'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react';
import { Logbook } from '@/components/logbook'
import useAuthStore from '@/store/auth-store';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/ui/use-toast';
import { Layout } from '@/components/dashboard-layout';

const queryClient = new QueryClient()

export default function LogbookPage() {
    const router = useRouter();
    const token = useAuthStore((state) => state.token);
    const clearToken = useAuthStore((state) => state.clearToken);
    const { toast } = useToast()

    useEffect(() => {
        if (!token) {
            router.push('/auth/login');
        }
    }, [token, router]);

    const handleLogout = () => {
        clearToken();
        router.push('/');
    };

    if (!token) {
        return null;
    }
    
    useEffect(() => {
        if (!token) {
            router.push('/auth/login');
        }
    }, [token, router]);

    return (
        <QueryClientProvider client={queryClient}>
        <Layout>
        <div className="container mx-auto px-4 py-8">
            <h1 className="text-3xl font-bold mb-6 text-center">Logbook</h1>
            <Logbook />
                </div>
        </Layout>
        </QueryClientProvider>
  )
}