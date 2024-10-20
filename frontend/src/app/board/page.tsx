'use client';

import { useEffect } from 'react';
import { Board } from '@/components/board'
import useAuthStore from '@/store/auth-store';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/ui/use-toast';
import { Layout } from '@/components/dashboard-layout';

export default function BoardPage() {
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
        <Layout>
            <Board />
        </Layout>
    );
}