
// page.tsx (root page)
'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import useAuthStore from '@/store/auth-store';
import { RunControl } from '@/components/run-control';
import { Stats } from '@/components/stats';
import HistogramsPage from '@/components/histo';
import { Layout } from '@/components/dashboard-layout';

const queryClient = new QueryClient()

export default function DashboardPage() {
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
    <QueryClientProvider client={queryClient}>
      <Layout>
        <div className="mb-8">
          <RunControl />
        </div>
        <div>
          <h2 className="text-2xl font-semibold mb-4">Live Statistics</h2>
          <Stats />
        </div>
        <div className="mb-8" />
        <div>
          <h3 className="text-2xl font-semibold mb-4">Plots</h3>
          <HistogramsPage />
        </div>
      </Layout>
    </QueryClientProvider>
  );
}

function MoonStarIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9" />
      <path d="M20 3v4" />
      <path d="M22 5h-4" />
    </svg>
  )
}