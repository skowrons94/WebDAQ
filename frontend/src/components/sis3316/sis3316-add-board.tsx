"use client"

import { useEffect, useState } from 'react'
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/use-toast"
import { Network, Plus, Search } from 'lucide-react'
import { addBoard, probeSis3316, type Sis3316Info } from '@/lib/api'

type Props = {
  existingIds: string[]
  disabled?: boolean
  onAdded: () => void
}

function serverMessage(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { message?: string; error?: string } } })?.response?.data
  return data?.message ?? data?.error ?? fallback
}

/**
 * Add a Struck SIS3316 reached over Ethernet. The board has no CAEN link: it is
 * addressed by IP (the PC maps that IP onto the board's MAC address, see the
 * SIS3316 Ethernet addendum), so the form asks for the IP and checks that a
 * board answers there before adding it.
 */
export function Sis3316AddBoard({ existingIds, disabled, onAdded }: Props) {
  const { toast } = useToast()
  const nextId = String(existingIds.length ? Math.max(...existingIds.map(Number)) + 1 : 0)
  const [id, setId] = useState(nextId)
  // The board list arrives after the first render (and changes when a board
  // is added): an ID that is now taken moves on to the next free one.
  const taken = existingIds.includes(id)
  useEffect(() => { if (taken) setId(nextId) }, [taken, nextId])
  const [host, setHost] = useState("192.168.1.100")
  const [probing, setProbing] = useState(false)
  const [adding, setAdding] = useState(false)
  const [found, setFound] = useState<Sis3316Info | null>(null)

  async function probe() {
    setProbing(true)
    setFound(null)
    try {
      setFound(await probeSis3316(host))
    } catch (error) {
      toast({ title: "No answer", description: serverMessage(error, `No SIS3316 answered at ${host}.`),
              variant: "destructive" })
    } finally {
      setProbing(false)
    }
  }

  async function add() {
    setAdding(true)
    try {
      await addBoard({ vendor: "sis3316", id, link_num: host })
      toast({ title: "Board added", description: `SIS3316 at ${host} is board ${id}.` })
      setFound(null)
      onAdded()
    } catch (error) {
      toast({ title: "Cannot add this board",
              description: serverMessage(error, "The SIS3316 could not be added."),
              variant: "destructive" })
    } finally {
      setAdding(false)
    }
  }

  return (
    <Card className="w-full mx-auto">
      <CardHeader>
        <CardTitle>Add a Struck SIS3316</CardTitle>
        <CardDescription>
          A 16-channel SIS3316 on the DAQ network link, addressed by its IP address.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="sis-id">Board ID</Label>
            <Input id="sis-id" value={id} onChange={(e) => setId(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sis-host">IP address</Label>
            <Input id="sis-host" value={host} onChange={(e) => { setHost(e.target.value); setFound(null) }}
                   placeholder="192.168.1.100" />
          </div>
        </div>

        {found && (
          <div className="rounded-lg border bg-muted/30 p-4 text-sm">
            <div className="flex items-center gap-2 font-medium">
              <Network className="h-4 w-4 text-primary" />
              SIS3316 serial {found.serial} ({found.adc_type})
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <dt className="text-muted-foreground">VME FPGA firmware</dt>
              <dd className="font-mono">{found.vme_fpga_firmware}</dd>
              <dt className="text-muted-foreground">ADC FPGA firmware</dt>
              <dd className="font-mono">{found.adc_fpga_firmware?.[0]}</dd>
              <dt className="text-muted-foreground">MAC address</dt>
              <dd className="font-mono">{found.mac}</dd>
              <dt className="text-muted-foreground">Temperature</dt>
              <dd>{found.temperature_c?.toFixed(1)} °C</dd>
            </dl>
            {found.already_configured && (
              <p className="mt-2 text-xs text-amber-600">This board is already configured.</p>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={probe} disabled={probing || disabled}>
            <Search className="mr-1.5 h-4 w-4" />
            {probing ? "Checking…" : "Check connection"}
          </Button>
          <Button type="button" onClick={add}
                  disabled={adding || disabled || !id.trim() || !!found?.already_configured}
                  title={disabled ? "Boards cannot be added while a run is going" : undefined}>
            <Plus className="mr-1.5 h-4 w-4" />
            {adding ? "Adding…" : "Add SIS3316"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
