import { NextRequest, NextResponse } from 'next/server'

const GRAFANA_URL = 'http://lunaserver:3000'
const GRAFANA_API_KEY = '' // Replace with your Grafana service account token

async function proxyToGrafana(request: NextRequest, path: string[]) {
  const grafanaPath = '/' + path.join('/')
  const url = `${GRAFANA_URL}${grafanaPath}`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Disable-Provenance': 'true',
  }
  if (GRAFANA_API_KEY) {
    headers['Authorization'] = `Bearer ${GRAFANA_API_KEY}`
  }

  const init: RequestInit = { method: request.method, headers }

  if (request.method === 'PUT' || request.method === 'POST') {
    init.body = await request.text()
  }

  try {
    const res = await fetch(url, init)
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Proxy error'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  return proxyToGrafana(request, params.path)
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  return proxyToGrafana(request, params.path)
}

export async function POST(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  return proxyToGrafana(request, params.path)
}
