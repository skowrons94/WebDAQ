'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import useAuthStore from '@/store/auth-store';
import { Layout } from '@/components/dashboard-layout';
import DataDashboard from '@/components/data-dashboard';

export default function DataPage() {
  const token = useAuthStore((state) => state.token);
  const router = useRouter();

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
      <div className="container mx-auto p-4">
        <DataDashboard />
      </div>
    </Layout>
  );
}
