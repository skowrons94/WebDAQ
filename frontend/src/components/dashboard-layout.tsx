import React, { useState } from 'react'
import {
    Activity,
    AlertTriangle,
    BarChart3,
    ChevronDown,
    CircleUser,
    Cog,
    Database,
    FlaskConical,
    Menu,
    PlayCircle,
    Power,
    Search,
    SlidersHorizontal,
    StopCircle,
    Thermometer,
} from "lucide-react"
import Link from "next/link"
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

export function Layout({ children }: { children: React.ReactNode }) {
    const clearToken = useAuthStore((state) => state.clearToken)
    const router = useRouter()
    const [open, setOpen] = useState(false)

    const handleLogout = () => {
        clearToken()
        router.push('/')
    }

    const handleSearch = (searchTerm: string) => {
        console.log('Searching for:', searchTerm)
        setOpen(false)
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
                    <Link
                        href="/dashboard"
                        className="text-foreground transition-colors hover:text-foreground"
                    >
                        Dashboard
                    </Link>
                    <Link
                        href="/logbook"
                        className="text-muted-foreground transition-colors hover:text-foreground"
                    >
                        
                        Logbook
                    </Link>
                    <Link
                        href="/stats"
                        className="text-muted-foreground transition-colors hover:text-foreground"
                    >

                        Stats
                    </Link>
                    <Link
                        href="http://lunaserver:3000"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground transition-colors hover:text-foreground"
                    >
                        Grafana
                    </Link>
                    <Link
                        href="/DAQ"
                        className="text-muted-foreground transition-colors hover:text-foreground"
                    >
                        DAQ
                    </Link>
                    <Link
                        href="/tuning"
                        className="text-muted-foreground transition-colors hover:text-foreground"
                    >
                        Tuning
                    </Link>
                    <Link
                        href="/tuner"
                        className="text-muted-foreground transition-colors hover:text-foreground"
                    >
                        Tuner
                    </Link>
                    <Link
                        href="/settings"
                        className="text-muted-foreground transition-colors hover:text-foreground"
                    >
                        Settings
                    </Link>
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
                                href="#"
                                className="flex items-center gap-2 text-lg font-semibold"
                            >
                                <MoonStarIcon className="w-8 h-8 text-primary" />
                                <span>LUNADAQ</span>
                            </Link>
                            <Link href="/dashboard" className="hover:text-foreground">
                                Dashboard
                            </Link>
                            <Link
                                href="/logbook"
                                className="text-muted-foreground hover:text-foreground"
                            >
                                Logbook
                            </Link>
                            <Link
                                href="/stats"
                                className="text-muted-foreground transition-colors hover:text-foreground"
                            >

                                Stats
                            </Link>
                            <Link
                                href="http://lunaserver:3000"
                                className="text-muted-foreground hover:text-foreground"
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                Grafana
                            </Link>
                            <Link
                                href="/DAQ"
                                className="text-muted-foreground hover:text-foreground"
                            >
                                DAQ
                            </Link>
                            <Link
                                href="/tuning"
                                className="text-muted-foreground hover:text-foreground"
                            >
                                Tuning
                            </Link>
                            <Link
                                href="/tuner"
                                className="text-muted-foreground hover:text-foreground"
                            >
                                Tuner
                            </Link>
                            <Link
                                href="/settings"
                                className="text-muted-foreground hover:text-foreground"
                            >
                                Settings
                            </Link>
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
                            <CommandGroup heading="Suggestions">
                                <CommandItem onSelect={() => handleSearch('Recent experiments')}>
                                    <FlaskConical className="mr-2 h-4 w-4" />
                                    <span>Recent experiments</span>
                                </CommandItem>
                                <CommandItem onSelect={() => handleSearch('Temperature data')}>
                                    <Thermometer className="mr-2 h-4 w-4" />
                                    <span>Temperature data</span>
                                </CommandItem>
                                <CommandItem onSelect={() => handleSearch('Activity logs')}>
                                    <Activity className="mr-2 h-4 w-4" />
                                    <span>Activity logs</span>
                                </CommandItem>
                            </CommandGroup>
                            <CommandSeparator />
                            <CommandGroup heading="Settings">
                                <CommandItem onSelect={() => router.push('/settings')}>
                                    <Cog className="mr-2 h-4 w-4" />
                                    <span>Open settings</span>
                                </CommandItem>
                            </CommandGroup>
                        </CommandList>
                    </CommandDialog>
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