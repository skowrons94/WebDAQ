'use client';

import { useEffect } from 'react';
import { JsonEditor } from '@/components/json'
import useAuthStore from '@/store/auth-store';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/ui/use-toast';
import { Layout } from '@/components/dashboard-layout';

export default function JsonEditorPage() {
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
        <Layout>
            <JsonEditor />
        </Layout>
    )
}