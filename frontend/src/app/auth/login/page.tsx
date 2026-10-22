'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthForm } from '@/components/auth-form';
import { login } from '@/lib/api';
import useAuthStore from '@/store/auth-store';
import { useToast } from '@/components/ui/use-toast';
import { safeNextPath } from '@/lib/safe-redirect';

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
        // Same-site paths only, so a crafted link cannot bounce someone
        // somewhere else once they have logged in (lib/safe-redirect.ts).
        setNext(safeNextPath(params.get('next'), window.location.origin));
    }, []);

    const handleLogin = async (data: { username?: string; password?: string }) => {
        if (!data.username || !data.password) {
            toast({
                title: 'Login failed',
                description: 'Username and password are required.',
                variant: 'destructive',
            });
            return;
        }
        try {
            const response = await login(data.username, data.password);
            setToken(response.data.token);
            router.push(next);
        } catch (error) {
            // Only the message: the error object carries the request, password included.
            console.error('Login error:', (error as Error)?.message ?? 'unknown error');
            toast({
                title: 'Login failed',
                description: 'Please check your credentials and try again.',
                variant: 'destructive',
            });
        }
    };

    return (
        <main className="flex min-h-screen items-center justify-center px-4 py-8">
            <div className="w-full max-w-md">
                <p className="mb-1 text-center text-sm font-semibold text-primary">
                    LUNADAQ
                </p>
                <h1 className="mb-6 text-center text-2xl font-bold">Log in</h1>
                {expired && (
                    <p className="mb-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-center text-sm">
                        Your session ended — log in again to carry on. The run is not
                        affected: the DAQ server keeps taking data with nobody logged in.
                    </p>
                )}
                <AuthForm onSubmit={handleLogin} type="login" />
            </div>
        </main>
    );
}
