import Link from "next/link"
import { Button } from "@/components/ui/button"
import useAuthStore from '@/store/auth-store';
import { useRouter } from 'next/navigation';
import { ModeToggle } from '@/components/ui/mode-toggle';

export function Layout({ children }: { children: React.ReactNode }) {
    const clearToken = useAuthStore((state) => state.clearToken)
    const router = useRouter();

    const handleLogout = () => {
        clearToken()
        router.push('/')
    }

    return (
        <div className="flex flex-col h-screen bg-background text-foreground">
            <header className="bg-card p-4 flex items-center justify-between shadow-sm fixed w-full z-10">
                <div className="flex items-center gap-4">
                    <MoonStarIcon className="w-8 h-8 text-primary" />
                    <h1 className="text-xl font-bold">LUNA Run Control Interface</h1>
                </div>
                <nav className="flex items-center gap-4">
                    <Link href="/dashboard" className="text-sm font-medium hover:underline">
                        Run Control
                    </Link>
                    <Link href="/board" className="text-sm font-medium hover:underline">
                        Boards
                    </Link>
                    <Link href="/logbook" className="text-sm font-medium hover:underline">
                        Logbook
                    </Link>
                    <Link href="/json" className="text-sm font-medium hover:underline">
                        JSON
                    </Link>
                    <Link href="http://lunaserver:3000" className="text-sm font-medium hover:underline">
                        Grafana
                    </Link>
                    <ModeToggle />
                    <Button variant="secondary" onClick={handleLogout}>Logout</Button>
                </nav>
            </header>
            <main className="flex-grow pt-20 px-4">
                {children}
            </main>
        </div>
    )
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