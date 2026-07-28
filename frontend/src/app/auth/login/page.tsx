'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthForm } from '@/components/auth-form';
import { login } from '@/lib/api';
import useAuthStore from '@/store/auth-store';
import { useToast } from '@/components/ui/use-toast';

export default function LoginPage() {
    const router = useRouter();
    const setToken = useAuthStore((state) => state.setToken);
    const { toast } = useToast();
    // Where to go after logging in, and whether we arrived here because a
    // session ran out. Read from the URL on the client, so no Suspense boundary
    // is needed around useSearchParams.
    const [next, setNext] = useState('/dashboard');
    const [expired, setExpired] = useState(false);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        setExpired(params.get('expired') === '1');
        const target = params.get('next');
        // Same-site paths only, so a crafted link cannot bounce someone
        // somewhere else once they have logged in.
        if (target && target.startsWith('/') && !target.startsWith('//')) {
            setNext(target);
        }
    }, []);

    const handleLogin = async (data: { username?: string; password?: string }) => {
        if (!data.username || !data.password) {
            toast({
                title: 'Login Failed',
                description: 'Username and Password are required.',
                variant: 'destructive',
            });
            return;
        }
        try {
            const response = await login(data.username, data.password);
            setToken(response.data.token);
            router.push(next);
        } catch (error) {
            console.error('Login error:', error);
            toast({
                title: 'Login Failed',
                description: 'Please check your credentials and try again.',
                variant: 'destructive',
            });
        }
    };

    return (
        <div className="flex items-center justify-center min-h-screen">
            <div className="w-full max-w-md">
                <h1 className="text-2xl font-bold mb-6 text-center">Login</h1>
                {expired && (
                    <p className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-center text-sm">
                        Your session ended — log in again to carry on. The run is not
                        affected: the DAQ server keeps taking data with nobody logged in.
                    </p>
                )}
                <AuthForm onSubmit={handleLogin} type="login" />
            </div>
        </div>
    );
}
