"use client"

import { AuthGate } from '@/components/auth-gate'
import Link from "next/link"
import { useParams } from "next/navigation"
import { ArrowLeft } from "lucide-react"

import { Layout } from "@/components/dashboard-layout"
import dynamic from "next/dynamic"
import { TabLoading } from "@/components/ui/tab-loading"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

// The run page (react-markdown, recharts) loads after the shell.
const RunDetailView = dynamic(
  () => import("@/components/data-dashboard").then((m) => m.RunDetailView),
  { ssr: false, loading: TabLoading },
)

function LogbookRunPageContent() {
  const params = useParams<{ run_number: string }>()
  const runNumber = Number(params.run_number)
  const validRunNumber = Number.isInteger(runNumber) && runNumber >= 0

  return (
    <Layout>
      <div className="mx-auto w-full max-w-[1600px] px-4 py-6">
        <div className="mb-4">
          <Button asChild variant="ghost" size="sm" className="-ml-3 mb-2">
            <Link href="/logbook">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to logbook
            </Link>
          </Button>
        </div>

        {validRunNumber ? (
          <RunDetailView runNumber={runNumber} />
        ) : (
          <Alert variant="destructive">
            <AlertTitle>Invalid run number</AlertTitle>
            <AlertDescription>
              This logbook address does not contain a valid run number.
            </AlertDescription>
          </Alert>
        )}
      </div>
    </Layout>
  )
}

// AuthGate: rendered only after hydration and only with a token (see
// components/auth-gate.tsx); it also provides the app's one QueryClient.
export default function LogbookRunPage() {
    return (
        <AuthGate>
            <LogbookRunPageContent />
        </AuthGate>
    )
}
