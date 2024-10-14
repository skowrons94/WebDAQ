'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Link from "next/link"

import { Button } from "@/components/ui/button"
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import useAuthStore from '@/store/auth-store';
import { RunControl } from '@/components/run-control';
import { Stats } from '@/components/stats';
import HistogramsPage from '@/components/histo';
import { useToast } from '@/components/ui/use-toast';
import { ModeToggle } from '@/components/ui/mode-toggle';

const queryClient = new QueryClient()



export default function DashboardPage() {

  const clearToken = useAuthStore((state) => state.clearToken)
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

  const handleLogout = () => {
    clearToken()
    router.push('/')
  }

  return (
    <QueryClientProvider client={queryClient}>
      <div className="flex flex-col h-screen bg-background text-foreground">

        <header className="bg-card p-4 flex items-center justify-between shadow-sm">
          <div className="flex items-center gap-4">
            <MoonStarIcon className="w-8 h-8 text-primary" />
            <h1 className="text-xl font-bold">LUNA Run Control Interface</h1>
          </div>
          <nav className="flex items-center gap-4">
            <Link href="#" className="text-sm font-medium hover:underline" prefetch={false}>
              Run Control
            </Link>
            <Link href="/board" className="text-sm font-medium hover:underline">
              Boards
            </Link>
            <Link href="/plots" className="text-sm font-medium hover:underline" prefetch={false}>
              Plots
            </Link>
            <Link href="#" className="text-sm font-medium hover:underline" prefetch={false}>
              Metadata
            </Link>
            <Link href="/logbook" className="text-sm font-medium hover:underline" prefetch={false}>
              Logbook
            </Link>
            <Link href="/json" className="text-sm font-medium hover:underline" prefetch={false}>
              JSON
            </Link>
            <Link href="http://lunaserver:3000" className="text-sm font-medium hover:underline" prefetch={false}>
              Grafana
            </Link>
            <ModeToggle />
            <Button variant="secondary" onClick={handleLogout}>Logout</Button>
          </nav>
        </header>

        <div className="mb-8 px-4">
          <RunControl />
        </div>
        <div className="px-4">
          <h2 className="text-2xl font-semibold mb-4">Live Statistics</h2>
          <Stats />
        </div>
        <div className="mb-8" />
        <div className="px-4">
          <h3 className="text-2xl font-semibold mb-4">Plots</h3>
          <HistogramsPage />
        </div>
      </div>
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