import React, { useState } from 'react'
import {
    AlertTriangle, HeartPulse, AudioWaveform, BarChart3, BellRing,
    ChevronDown, CircleUser, Cog, Cpu, FlaskConical, Gauge, GitBranch,
    LineChart, Menu, Search, SlidersHorizontal,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
    DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuRadioGroup,
    DropdownMenuRadioItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import {
    CommandDialog, CommandEmpty, CommandGroup, CommandInput,
    CommandItem, CommandList, CommandSeparator,
} from '@/components/ui/command'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import useAuthStore from '@/store/auth-store'
import { NotificationBell } from '@/components/notification-bell'
import { useDashboardTabStore } from '@/store/dashboard-tab-store'
import { ServerStatus } from '@/components/server-status'
import { RunStatusIndicator } from '@/components/run-status-indicator'

// Shared by desktop dropdowns, mobile sections, breadcrumbs and page search.
const NAV_GROUPS = [
    { label: 'Data', items: [
        { href: '/logbook', label: 'Logbook', icon: FlaskConical },
        { href: '/analysis', label: 'Analysis', icon: GitBranch },
    ] },
    { label: 'Instrument', items: [
        { href: '/DAQ', label: 'DAQ Configuration', icon: Cpu },
        { href: '/tuner', label: 'Tuner', icon: SlidersHorizontal },
    ] },
    { label: 'Monitoring', items: [
        { href: '/stats', label: 'Stats', icon: LineChart },
        { href: '/alerts', label: 'Alerts', icon: AlertTriangle },
        { href: '/troubleshoot', label: 'Troubleshoot', icon: HeartPulse },
    ] },
]

export function Layout({ children }: { children: React.ReactNode }) {
    const clearToken = useAuthStore(state => state.clearToken)
    const router = useRouter()
    const setDashboardTab = useDashboardTabStore(state => state.setTab)
    const pathname = usePathname()
    const { theme, setTheme } = useTheme()
    const [open, setOpen] = useState(false)
    const [mobileOpen, setMobileOpen] = useState(false)
    const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/')
    const activeGroup = NAV_GROUPS.find(group => group.items.some(item => isActive(item.href)))
    const activePage = activeGroup?.items.find(item => isActive(item.href))
    const runNumber = pathname.match(/^\/logbook\/(\d+)$/)?.[1]

    const handleLogout = () => { clearToken(); router.push('/') }
    const goToTab = (tab: string) => {
        setDashboardTab(tab)
        setOpen(false)
        router.push('/dashboard')
    }
    const go = (href: string) => { setOpen(false); router.push(href) }
    const linkStyle = (href: string) => isActive(href)
        ? 'bg-accent text-accent-foreground font-semibold'
        : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'

    return (
        <div className="flex min-h-screen w-full flex-col">
            <header className="sticky top-0 z-50 flex h-16 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur-sm sm:gap-4 md:px-6">
                <nav aria-label="Main navigation" className="hidden shrink-0 items-center gap-1 lg:flex">
                    <Link href="/dashboard" className="mr-3 flex items-center gap-2 font-semibold">
                        <MoonStarIcon className="h-8 w-8 text-primary" />
                        <span>LUNADAQ</span>
                    </Link>
                    <Link href="/dashboard" aria-current={isActive('/dashboard') ? 'page' : undefined}
                        className={`rounded-md px-3 py-2 text-sm transition-colors ${linkStyle('/dashboard')}`}>
                        Dashboard
                    </Link>
                    {NAV_GROUPS.map(group => (
                        <DropdownMenu key={group.label}>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost" className={`gap-1.5 px-3 ${activeGroup === group ? 'bg-accent text-accent-foreground font-semibold' : 'text-muted-foreground'}`}>
                                    {group.label}<ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" className="min-w-52">
                                {group.items.map(item => (
                                    <DropdownMenuItem key={item.href} asChild>
                                        <Link href={item.href} aria-current={isActive(item.href) ? 'page' : undefined}
                                            className={isActive(item.href) ? 'bg-accent font-semibold' : ''}>
                                            <item.icon className="mr-2 h-4 w-4" />{item.label}
                                        </Link>
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    ))}
                </nav>
                <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
                    <SheetTrigger asChild>
                        <Button variant="outline" size="icon" className="shrink-0 lg:hidden" aria-label="Open navigation">
                            <Menu className="h-5 w-5" />
                        </Button>
                    </SheetTrigger>
                    <SheetContent side="left" className="overflow-y-auto">
                        <SheetTitle className="mb-6 flex items-center gap-2">
                            <MoonStarIcon className="h-8 w-8 text-primary" />LUNADAQ
                        </SheetTitle>
                        <nav aria-label="Mobile navigation">
                            <Link href="/dashboard" onClick={() => setMobileOpen(false)}
                                aria-current={isActive('/dashboard') ? 'page' : undefined}
                                className={`block rounded-md px-3 py-2 ${linkStyle('/dashboard')}`}>Dashboard</Link>
                            <Accordion type="multiple" defaultValue={activeGroup ? [activeGroup.label] : []} className="mt-2">
                                {NAV_GROUPS.map(group => (
                                    <AccordionItem key={group.label} value={group.label}>
                                        <AccordionTrigger className={`px-3 ${activeGroup === group ? 'text-primary' : ''}`}>{group.label}</AccordionTrigger>
                                        <AccordionContent className="space-y-1">
                                            {group.items.map(item => (
                                                <Link key={item.href} href={item.href} onClick={() => setMobileOpen(false)}
                                                    aria-current={isActive(item.href) ? 'page' : undefined}
                                                    className={`flex items-center gap-2 rounded-md px-3 py-2 ${linkStyle(item.href)}`}>
                                                    <item.icon className="h-4 w-4" />{item.label}
                                                </Link>
                                            ))}
                                        </AccordionContent>
                                    </AccordionItem>
                                ))}
                            </Accordion>
                        </nav>
                    </SheetContent>
                </Sheet>
                <div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-2">
                    <Button variant="ghost" size="icon" className="shrink-0" aria-label="Search pages and commands"
                        title="Search pages and commands" onClick={() => setOpen(true)}>
                        <Search className="h-4 w-4" />
                    </Button>
                    <CommandDialog open={open} onOpenChange={setOpen}>
                        <CommandInput placeholder="Type a command or search..." />
                        <CommandList>
                            <CommandEmpty>No results found.</CommandEmpty>
                            <CommandGroup heading="Overview">
                                <CommandItem onSelect={() => go('/dashboard')}><BarChart3 className="mr-2 h-4 w-4" />Dashboard</CommandItem>
                            </CommandGroup>
                            {NAV_GROUPS.map(group => (
                                <CommandGroup key={group.label} heading={group.label}>
                                    {group.items.map(item => (
                                        <CommandItem key={item.href} onSelect={() => go(item.href)}>
                                            <item.icon className="mr-2 h-4 w-4" />{item.label}
                                        </CommandItem>
                                    ))}
                                </CommandGroup>
                            ))}
                            <CommandSeparator />
                            <CommandGroup heading="Visualization">
                                <CommandItem onSelect={() => goToTab('histograms')}><BarChart3 className="mr-2 h-4 w-4" />Histograms</CommandItem>
                                <CommandItem onSelect={() => goToTab('health')}><HeartPulse className="mr-2 h-4 w-4" />Board Health</CommandItem>
                                <CommandItem onSelect={() => goToTab('waveforms')}><AudioWaveform className="mr-2 h-4 w-4" />Waveforms</CommandItem>
                            </CommandGroup>
                            <CommandSeparator />
                            <CommandGroup heading="Settings">
                                <CommandItem onSelect={() => go('/settings?view=boards')}><Cpu className="mr-2 h-4 w-4" />Boards</CommandItem>
                                <CommandItem onSelect={() => go('/settings?view=current')}><Gauge className="mr-2 h-4 w-4" />Current Module</CommandItem>
                                <CommandItem onSelect={() => go('/settings?view=notifications')}><BellRing className="mr-2 h-4 w-4" />Notifications</CommandItem>
                                <CommandItem onSelect={() => go('/settings?view=appearance')}><SlidersHorizontal className="mr-2 h-4 w-4" />Appearance</CommandItem>
                                <CommandItem onSelect={() => go('/settings')}><Cog className="mr-2 h-4 w-4" />Open settings</CommandItem>
                            </CommandGroup>
                        </CommandList>
                    </CommandDialog>
                    <RunStatusIndicator />
                    <ServerStatus />
                    <NotificationBell />
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="secondary" size="icon" className="shrink-0 rounded-full" aria-label="Open user menu">
                                <CircleUser className="h-5 w-5" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-48">
                            <DropdownMenuLabel>My Account</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem asChild><Link href="/settings"><Cog className="mr-2 h-4 w-4" />Settings</Link></DropdownMenuItem>
                            <DropdownMenuSub>
                                <DropdownMenuSubTrigger>Theme</DropdownMenuSubTrigger>
                                <DropdownMenuSubContent>
                                    <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
                                        <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
                                        <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
                                        <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
                                    </DropdownMenuRadioGroup>
                                </DropdownMenuSubContent>
                            </DropdownMenuSub>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={handleLogout}>Log out</DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </header>
            <main className="flex-1 px-4 pt-4 md:px-8 md:pt-6">
                {activeGroup && activePage && (
                    <nav aria-label="Breadcrumb" className="mb-4 text-sm text-muted-foreground">
                        <ol className="flex flex-wrap items-center gap-2">
                            <li>{activeGroup.label}</li>
                            <li aria-hidden="true">/</li>
                            <li>{runNumber ? <Link href={activePage.href} className="hover:text-foreground">{activePage.label}</Link>
                                : <span aria-current="page" className="font-medium text-foreground">{activePage.label}</span>}</li>
                            {runNumber && <><li aria-hidden="true">/</li><li aria-current="page" className="font-medium text-foreground">Run {runNumber}</li></>}
                        </ol>
                    </nav>
                )}
                {children}
            </main>
            <footer className="mt-auto flex h-16 items-center justify-center bg-background text-muted-foreground">
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
