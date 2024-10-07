'use client';

import { useMutation, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import useAuthStore from '@/store/auth-store';
import { RunControl } from '@/components/run-control';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';


const queryClient = new QueryClient()

export default function DashboardPage() {
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

    return (
        <QueryClientProvider client={queryClient}>
        <div className="container mx-auto px-4 py-8">
                    <RunControl />
            </div>
        </QueryClientProvider>
    );
}