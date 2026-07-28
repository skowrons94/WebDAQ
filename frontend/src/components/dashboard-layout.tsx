import React, { useState } from 'react'
import {
    AlertTriangle,
    AudioWaveform,
    BarChart3,
    BellRing,
    ChevronDown,
    CircleUser,
    Cog,
    Cpu,
    Database,
    FlaskConical,
    Gauge,
    LineChart,
    Menu,
    PlayCircle,
    Power,
    Search,
    SlidersHorizontal,
    StopCircle,
} from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
    Command,
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    CommandSeparator,
    CommandShortcut,
} from "@/components/ui/command"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import useAuthStore from '@/store/auth-store'
import { useRouter } from 'next/navigation'
import { ModeToggle } from '@/components/ui/mode-toggle'
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet"
import { ServerStatus } from '@/components/server-status'

// Top-level pages, in nav order. Used for both the desktop and mobile menus
// and to highlight the page the user is currently on.
const NAV_ITEMS = [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/logbook", label: "Logbook" },
    { href: "/data", label: "Data" },
    { href: "/stats", label: "Stats" },
    { href: "/DAQ", label: "DAQ" },
    { href: "/tuner", label: "Tuner" },
    { href: "/alerts", label: "Alerts" },
    { href: "/settings", label: "Settings" },
]

export function Layout({ children }: { children: React.ReactNode }) {
    const clearToken = useAuthStore((state) => state.clearToken)
    const router = useRouter()
    const pathname = usePathname()
    const [open, setOpen] = useState(false)

    // A nav entry is active when the current path matches it exactly or is a
    // nested route beneath it (e.g. /settings/foo highlights Settings).
    const isActive = (href: string) =>
        pathname === href || pathname.startsWith(href + "/")

    const handleLogout = () => {
        clearToken()
        router.push('/')
    }

    // Navigate from the command palette and close it.
    const go = (href: string) => {
        setOpen(false)
        router.push(href)
    }

    return (
        <div className="flex min-h-screen w-full flex-col">
            <header className="sticky top-0 flex h-16 items-center gap-4 border-b bg-background/80 backdrop-blur-sm px-4 md:px-6 z-50">
                <nav className="hidden flex-col gap-6 text-lg font-medium md:flex md:flex-row md:items-center md:gap-5 md:text-sm lg:gap-6">
                    <Link
                        href="/dashboard"
                        className="flex items-center gap-2 text-lg font-semibold md:text-base"
                    >
                        <MoonStarIcon className="w-8 h-8 text-primary" />
                        <span>LUNADAQ</span>
                    </Link>
                    {NAV_ITEMS.map((item) => (
                        <Link
                            key={item.href}
                            href={item.href}
                            className={`transition-colors hover:text-foreground ${
                                isActive(item.href)
                                    ? "text-foreground font-semibold"
                                    : "text-muted-foreground"
                            }`}
                        >
                            {item.label}
                        </Link>
                    ))}
                </nav>
                <Sheet>
                    <SheetTrigger asChild>
                        <Button
                            variant="outline"
                            size="icon"
                            className="shrink-0 md:hidden"
                        >
                            <Menu className="h-5 w-5" />
                            <span className="sr-only">Toggle navigation menu</span>
                        </Button>
                    </SheetTrigger>
                    <SheetContent side="left">
                        <nav className="grid gap-6 text-lg font-medium">
                            <Link
                                href="/dashboard"
                                className="flex items-center gap-2 text-lg font-semibold"
                            >
                                <MoonStarIcon className="w-8 h-8 text-primary" />
                                <span>LUNADAQ</span>
                            </Link>
                            {NAV_ITEMS.map((item) => (
                                <Link
                                    key={item.href}
                                    href={item.href}
                                    className={`transition-colors hover:text-foreground ${
                                        isActive(item.href)
                                            ? "text-foreground font-semibold"
                                            : "text-muted-foreground"
                                    }`}
                                >
                                    {item.label}
                                </Link>
                            ))}
                        </nav>
                    </SheetContent>
                </Sheet>
                <div className="flex w-full items-center gap-4 md:ml-auto md:gap-2 lg:gap-4">
                    <Button
                        variant="outline"
                        className="ml-auto flex-1 sm:flex-initial"
                        onClick={() => setOpen(true)}
                    >
                        <Search className="mr-2 h-4 w-4" />
                        Search...
                    </Button>
                    <CommandDialog open={open} onOpenChange={setOpen}>
                        <CommandInput placeholder="Type a command or search..." />
                        <CommandList>
                            <CommandEmpty>No results found.</CommandEmpty>
                            <CommandGroup heading="Pages">
                                <CommandItem onSelect={() => go('/dashboard')}>
                                    <BarChart3 className="mr-2 h-4 w-4" />
                                    <span>Dashboard</span>
                                </CommandItem>
                                <CommandItem onSelect={() => go('/logbook')}>
                                    <FlaskConical className="mr-2 h-4 w-4" />
                                    <span>Logbook</span>
                                </CommandItem>
                                <CommandItem onSelect={() => go('/stats')}>
                                    <LineChart className="mr-2 h-4 w-4" />
                                    <span>Stats</span>
                                </CommandItem>
                                <CommandItem onSelect={() => go('/alerts')}>
                                    <AlertTriangle className="mr-2 h-4 w-4" />
                                    <span>Alerts</span>
                                </CommandItem>
                            </CommandGroup>
                            <CommandSeparator />
                            <CommandGroup heading="Visualization">
                                <CommandItem onSelect={() => go('/dashboard?tab=histograms')}>
                                    <BarChart3 className="mr-2 h-4 w-4" />
                                    <span>Histograms</span>
                                </CommandItem>
                                <CommandItem onSelect={() => go('/dashboard?tab=waveforms')}>
                                    <AudioWaveform className="mr-2 h-4 w-4" />
                                    <span>Waveforms</span>
                                </CommandItem>
                            </CommandGroup>
                            <CommandSeparator />
                            <CommandGroup heading="Settings">
                                <CommandItem onSelect={() => go('/settings?view=boards')}>
                                    <Cpu className="mr-2 h-4 w-4" />
                                    <span>Boards</span>
                                </CommandItem>
                                <CommandItem onSelect={() => go('/settings?view=current')}>
                                    <Gauge className="mr-2 h-4 w-4" />
                                    <span>Current Module</span>
                                </CommandItem>
                                <CommandItem onSelect={() => go('/settings?view=notifications')}>
                                    <BellRing className="mr-2 h-4 w-4" />
                                    <span>Notifications</span>
                                </CommandItem>
                                <CommandItem onSelect={() => go('/settings?view=appearance')}>
                                    <SlidersHorizontal className="mr-2 h-4 w-4" />
                                    <span>Appearance</span>
                                </CommandItem>
                                <CommandItem onSelect={() => go('/settings')}>
                                    <Cog className="mr-2 h-4 w-4" />
                                    <span>Open settings</span>
                                </CommandItem>
                            </CommandGroup>
                        </CommandList>
                    </CommandDialog>
                    <ServerStatus />
                    <ModeToggle />
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="secondary" size="icon" className="rounded-full">
                                <CircleUser className="h-5 w-5" />
                                <span className="sr-only">Toggle user menu</span>
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuLabel>My Account</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem>Profile</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => router.push('/settings')}>Settings</DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={handleLogout}>Log out</DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </header>
            <main className="flex-1 pt-4 md:pt-8 px-4 md:px-8">
                {children}
            </main>
            <footer className="mt-auto flex items-center justify-center h-16 bg-background text-muted-foreground">
                <span>&copy; 2025 LUNADAQ</span>
            </footer>
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