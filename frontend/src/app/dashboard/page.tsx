'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import useAuthStore from '@/store/auth-store';
import { RunControl } from '@/components/run-control';
import { Stats } from '@/components/stats';
import { HistogramsPage } from '@/components/histo';
import { useToast } from '@/components/ui/use-toast';

const queryClient = new QueryClient()

export default function DashboardPage() {
    const router = useRouter();
    const token = useAuthStore((state) => state.token);
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
            <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">LUNA Run Control Dashboard</h1>
      <div className="mb-8">
        <RunControl />
      </div>
      <div>
        <h2 className="text-xl font-semibold mb-4">Live Statistics</h2>
        <HistogramsPage />
      </div>
    </div>
        </QueryClientProvider>
    );
}