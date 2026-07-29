"use client"

import { useEffect } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import { ArrowLeft } from "lucide-react"

import { Layout } from "@/components/dashboard-layout"
import { RunDetailView } from "@/components/data-dashboard"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import useAuthStore from "@/store/auth-store"

export default function LogbookRunPage() {
  const token = useAuthStore((state) => state.token)
  const router = useRouter()
  const params = useParams<{ run_number: string }>()
  const runNumber = Number(params.run_number)
  const validRunNumber = Number.isInteger(runNumber) && runNumber >= 0

  useEffect(() => {
    if (!token) router.push("/auth/login")
  }, [token, router])

  if (!token) return null

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
