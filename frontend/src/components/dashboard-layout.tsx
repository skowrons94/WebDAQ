import React, { useEffect, useRef, useState } from 'react'
import {
    AlertTriangle,
    HeartPulse,
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
    GitMerge,
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
import { NotificationBell } from '@/components/notification-bell'
import { useDashboardTabStore } from '@/store/dashboard-tab-store'
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import dynamic from 'next/dynamic'
import { useIsPhone } from '@/hooks/use-is-phone'

// Phones only, so desktops never download it.
const RunBar = dynamic(() => import('@/components/run-bar').then((m) => m.RunBar), { ssr: false })
import { ServerStatus } from '@/components/server-status'
import { RunStatusIndicator } from '@/components/run-status-indicator'

// Top-level pages, in nav order. Used for both the desktop and mobile menus
// and to highlight the page the user is currently on.
const NAV_ITEMS = [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/logbook", label: "Logbook" },
    { href: "/stats", label: "Stats" },
    // Where boards are discovered (scan) and added. It used to be reachable
    // only through Settings → Boards, a place nobody looked for it.
    { href: "/board", label: "Boards" },
    { href: "/DAQ", label: "DAQ" },
    { href: "/tuner", label: "Tuner" },
    { href: "/troubleshoot", label: "Troubleshoot" },
    { href: "/alerts", label: "Alerts" },
    { href: "/settings", label: "Settings" },
]

export function Layout({ children }: { children: React.ReactNode }) {
    const clearToken = useAuthStore((state) => state.clearToken)
    const router = useRouter()
    const setDashboardTab = useDashboardTabStore((state) => state.setTab)
    const pathname = usePathname()
    const [open, setOpen] = useState(false)
    const [menuOpen, setMenuOpen] = useState(false)
    const menuButtonRef = useRef<HTMLButtonElement>(null)
    const firstNavRef = useRef<HTMLAnchorElement>(null)
    // Closing the menu to open Search: focus goes to the search box, not back
    // to the menu button.
    const toSearch = useRef(false)
    const phone = useIsPhone()

    // A nav entry is active when the current path matches it exactly or is a
    // nested route beneath it (e.g. /settings/foo highlights Settings).
    // Paths are compared without a trailing slash (static exports add one).
    const path = (pathname || "/").replace(/\/+$/, "") || "/"
    const isActive = (href: string) =>
        path === href || path.startsWith(href + "/")

    // "<Page> · LUNADAQ" in the browser tab, so a row of tabs in the control
    // room can be told apart.
    useEffect(() => {
        const item = NAV_ITEMS.find((i) => isActive(i.href))
        document.title = item ? `${item.label} · LUNADAQ` : "LUNADAQ"
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [path])

    const handleLogout = () => {
        clearToken()
        router.push('/')
    }

    // Navigate from the command palette and close it.
    const goToTab = (tab: string) => {
        setDashboardTab(tab)
        setOpen(false)
        router.push('/dashboard')
    }

    const go = (href: string) => {
        setOpen(false)
        router.push(href)
    }

    const navLinkClass = (href: string) =>
        `rounded-sm transition-colors hover:text-foreground ${
            isActive(href)
                ? "text-foreground font-semibold underline decoration-primary decoration-2 underline-offset-[6px]"
                : "text-muted-foreground"
        }`

    return (
        // Bottom padding below md leaves room for the fixed run bar.
        <div className="flex min-h-screen w-full flex-col pb-[4.75rem] md:pb-0">
            {/* Keyboard users jump past the header and nav. */}
            <a
                href="#main"
                className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[100] focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:shadow"
            >
                Skip to content
            </a>
            {/* Below lg: menu, logo, run state, bell, account — nothing else, so
                the bell and the run state are never pushed off a phone screen.
                Search, server status and the theme live in the menu sheet. */}
            <header className="sticky top-0 z-50 flex h-16 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur-sm sm:gap-3 md:px-6">
                <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
                    <SheetTrigger asChild>
                        <Button
                            ref={menuButtonRef}
                            variant="outline"
                            size="icon"
                            className="shrink-0 lg:hidden"
                        >
                            <Menu className="h-5 w-5" />
                            <span className="sr-only">Open navigation menu</span>
                        </Button>
                    </SheetTrigger>
                    <SheetContent
                        side="left"
                        className="flex w-[18rem] flex-col gap-6 overflow-y-auto sm:w-[20rem]"
                        // Focus starts on the first page in the menu, and goes
                        // back to the menu button when it closes.
                        onOpenAutoFocus={(e) => { e.preventDefault(); firstNavRef.current?.focus() }}
                        onCloseAutoFocus={(e) => {
                            if (toSearch.current) { toSearch.current = false; e.preventDefault(); return }
                            e.preventDefault()
                            menuButtonRef.current?.focus()
                        }}
                    >
                        <SheetTitle className="flex items-center gap-2 text-lg font-semibold">
                            <MoonStarIcon className="h-7 w-7 text-primary" aria-hidden="true" />
                            LUNADAQ
                        </SheetTitle>
                        <nav aria-label="Main" className="grid gap-1 text-base font-medium">
                            {NAV_ITEMS.map((item, i) => (
                                <SheetClose asChild key={item.href}>
                                    <Link
                                        ref={i === 0 ? firstNavRef : undefined}
                                        href={item.href}
                                        aria-current={isActive(item.href) ? "page" : undefined}
                                        className={`flex min-h-11 items-center rounded-md px-2 ${
                                            isActive(item.href)
                                                ? "bg-muted font-semibold text-foreground"
                                                : "text-muted-foreground hover:bg-muted hover:text-foreground"
                                        }`}
                                    >
                                        {item.label}
                                    </Link>
                                </SheetClose>
                            ))}
                        </nav>
                        <div className="grid gap-3 border-t pt-4">
                            <Button
                                variant="outline"
                                className="justify-start"
                                onClick={() => { toSearch.current = true; setMenuOpen(false); setOpen(true) }}
                            >
                                <Search className="mr-2 h-4 w-4" />
                                Search…
                            </Button>
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-sm text-muted-foreground">Theme</span>
                                <ModeToggle />
                            </div>
                            <div className="rounded-md border">
                                <ServerStatus align="left" showLabel />
                            </div>
                        </div>
                    </SheetContent>
                </Sheet>
                <Link
                    href="/dashboard"
                    className="flex shrink-0 items-center gap-2 text-base font-semibold pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                    aria-label="LUNADAQ dashboard"
                >
                    <MoonStarIcon className="h-7 w-7 text-primary" aria-hidden="true" />
                    <span className="hidden sm:inline">LUNADAQ</span>
                </Link>
                <nav aria-label="Main" className="hidden items-center gap-2.5 text-sm font-medium lg:flex xl:gap-5">
                    {NAV_ITEMS.map((item) => (
                        <Link
                            key={item.href}
                            href={item.href}
                            aria-current={isActive(item.href) ? "page" : undefined}
                            className={navLinkClass(item.href)}
                        >
                            {item.label}
                        </Link>
                    ))}
                </nav>
                <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2">
                    <Button
                        variant="outline"
                        size="icon"
                        className="hidden lg:inline-flex xl:hidden"
                        onClick={() => setOpen(true)}
                        aria-label="Search"
                    >
                        <Search className="h-4 w-4" />
                    </Button>
                    <Button
                        variant="outline"
                        className="hidden xl:inline-flex"
                        onClick={() => setOpen(true)}
                    >
                        <Search className="mr-2 h-4 w-4" />
                        Search…
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
                                <CommandItem onSelect={() => go('/board')}>
                                    <Cpu className="mr-2 h-4 w-4" />
                                    <span>Boards: discover and add</span>
                                </CommandItem>
                                <CommandItem onSelect={() => go('/stats')}>
                                    <LineChart className="mr-2 h-4 w-4" />
                                    <span>Stats</span>
                                </CommandItem>
                                <CommandItem onSelect={() => go('/troubleshoot')}>
                                    <BellRing className="mr-2 h-4 w-4" />
                                    <span>Troubleshoot &amp; recovery</span>
                                </CommandItem>
                                <CommandItem onSelect={() => go('/alerts')}>
                                    <AlertTriangle className="mr-2 h-4 w-4" />
                                    <span>Alerts</span>
                                </CommandItem>
                            </CommandGroup>
                            <CommandSeparator />
                            <CommandGroup heading="Visualization">
                                <CommandItem onSelect={() => goToTab('histograms')}>
                                    <BarChart3 className="mr-2 h-4 w-4" />
                                    <span>Histograms</span>
                                </CommandItem>
                                <CommandItem onSelect={() => goToTab('health')}>
                                    <HeartPulse className="mr-2 h-4 w-4" />
                                    <span>Board health</span>
                                </CommandItem>
                                <CommandItem onSelect={() => goToTab('waveforms')}>
                                    <AudioWaveform className="mr-2 h-4 w-4" />
                                    <span>Waveforms</span>
                                </CommandItem>
                                <CommandItem onSelect={() => goToTab('coincidences')}>
                                    <GitMerge className="mr-2 h-4 w-4" />
                                    <span>Coincidences</span>
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
                                    <span>Current module</span>
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
                    <RunStatusIndicator />
                    <div className="hidden lg:block">
                        <ServerStatus />
                    </div>
                    {/* What the DAQ did while nobody was watching. Never hidden. */}
                    <NotificationBell />
                    {/* Below xl the theme is under Settings → Appearance (the header must fit at 1024). */}
                    <div className="hidden xl:block">
                        <ModeToggle />
                    </div>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="secondary" size="icon" className="shrink-0 rounded-full">
                                <CircleUser className="h-5 w-5" />
                                <span className="sr-only">Account menu</span>
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuLabel>My account</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => router.push('/settings')}>Settings</DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={handleLogout}>Log out</DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </header>
            <main id="main" tabIndex={-1} className="flex-1 px-4 pt-4 outline-none md:px-8 md:pt-8">
                {children}
            </main>
            <footer className="mt-auto flex h-16 items-center justify-center bg-background text-sm text-muted-foreground">
                <span>LUNADAQ</span>
            </footer>
            {phone && <RunBar />}
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
