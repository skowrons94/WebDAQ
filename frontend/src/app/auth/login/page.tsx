'use client';

import { useRouter } from 'next/navigation';
import { AuthForm } from '@/components/auth-form';
import { login } from '@/lib/api';
import useAuthStore from '@/store/auth-store';
import { useToast } from '@/components/ui/use-toast';

export default function LoginPage() {
    const router = useRouter();
    const setToken = useAuthStore((state) => state.setToken);
    const { toast } = useToast();

    const handleLogin = async (data: { username?: string; password?: string }) => {
        console.log('Login attempt with:', data);
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
                console.log('Login response:', response);
                setToken(response.data.token);
                router.push('/dashboard');
            } catch (error) {
                console.error('Login error:', error);
                toast({
                    title: 'Login Failed',
                    description: 'Please check your credentials and try again.',
                    variant: 'destructive',
                });
            
        }
    };

    console.log('Rendering LoginPage');

    return (
        <div className="flex items-center justify-center min-h-screen">
            <div className="w-full max-w-md">
                <h1 className="text-2xl font-bold mb-6 text-center">Login</h1>
                <AuthForm onSubmit={handleLogin} type="login" />
            </div>
        </div>
    );
}