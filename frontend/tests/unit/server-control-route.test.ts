import { describe, expect, it } from 'vitest'
import { GET, POST } from '@/app/api/server-control/route'

// The route handler itself (S2): with the DAQ server up, no token, no stop.
// fetch is stubbed: /protected answers 401 to anything but "Bearer good".
const stubServer = () => {
  const real = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
    if (url.endsWith('/protected')) return new Response('{}', { status: auth === 'Bearer good' ? 200 : 401 })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  return () => { globalThis.fetch = real }
}

const post = (body: unknown, auth?: string) => new Request('http://localhost:3000/api/server-control', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
  body: JSON.stringify(body),
})

describe('/api/server-control (S2)', () => {
  it('refuses stop without a token: 401', async () => {
    const restore = stubServer()
    try {
      const res = await POST(post({ action: 'stop' }))
      expect(res.status).toBe(401)
    } finally { restore() }
  })
  it('refuses stop with a token the server rejects: 401', async () => {
    const restore = stubServer()
    try {
      expect((await POST(post({ action: 'stop' }, 'Bearer stale'))).status).toBe(401)
    } finally { restore() }
  })
  it('refuses the log without a token while the server is up, keeps the status public', async () => {
    const restore = stubServer()
    try {
      expect((await GET(new Request('http://localhost:3000/api/server-control?logs=1'))).status).toBe(401)
      expect((await GET(new Request('http://localhost:3000/api/server-control'))).status).toBe(200)
    } finally { restore() }
  })
})
