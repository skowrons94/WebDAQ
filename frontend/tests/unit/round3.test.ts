import { describe, expect, it } from 'vitest'
import { runSideEffects } from '@/lib/side-effects'
import { bearerToken, checkLauncherAuth, launcherAllows } from '@/lib/launcher-auth'
import { safeNextPath } from '@/lib/safe-redirect'

// ── S1: a failure after the start is a warning, and later steps still run ──
describe('post-start side effects (S1)', () => {
  it('a failing Logbook write becomes a warning; the alerts are still unpaused', async () => {
    const done: string[] = []
    const warnings = await runSideEffects([
      { warning: 'the run start time could not be read', run: async () => { done.push('start time') } },
      { warning: 'the run name and type were not saved to the Logbook', run: async () => { throw new Error('404 Run not found') } },
      false,
      { warning: 'the auto-managed Grafana alerts were not unpaused', run: () => { done.push('alerts') } },
    ])
    expect(warnings).toEqual(['the run name and type were not saved to the Logbook'])
    expect(done).toEqual(['start time', 'alerts'])
  })
  it('no failure, no warning', async () => {
    expect(await runSideEffects([{ warning: 'x', run: () => 1 }])).toEqual([])
  })
})

// ── S2: the launcher route needs a token the DAQ server accepts ──
describe('launcher authentication (S2)', () => {
  const server = (accept: string | null) => (async (_url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
    return new Response('{}', { status: accept && auth === `Bearer ${accept}` ? 200 : 401 })
  }) as unknown as typeof fetch
  const down = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch

  it('reads a bearer token', () => {
    expect(bearerToken('Bearer abc.def')).toBe('abc.def')
    expect(bearerToken('Basic x')).toBeNull()
    expect(bearerToken(null)).toBeNull()
  })
  it('stop without a token is refused while the server is up', async () => {
    const a = await checkLauncherAuth(null, ['http://daq:5001'], server('good'))
    expect(a).toEqual({ backendUp: true, tokenOk: false, hasToken: false })
    expect(launcherAllows('stop', a)).toBe(false)
    expect(launcherAllows('start', a)).toBe(false)
    expect(launcherAllows('logs', a)).toBe(false)
    expect(launcherAllows('status', a)).toBe(true)
  })
  it('a token the server rejects is refused; the one it accepts is allowed', async () => {
    expect(launcherAllows('stop', await checkLauncherAuth('Bearer stale', ['http://daq:5001'], server('good')))).toBe(false)
    expect(launcherAllows('stop', await checkLauncherAuth('Bearer good', ['http://daq:5001'], server('good')))).toBe(true)
  })
  it('with the server down: start and the launch log stay open, stop still needs a token', async () => {
    const anon = await checkLauncherAuth(null, ['http://daq:5001', 'http://127.0.0.1:5001'], down)
    expect(anon.backendUp).toBe(false)
    expect(launcherAllows('start', anon)).toBe(true)
    expect(launcherAllows('logs', anon)).toBe(true)
    expect(launcherAllows('stop', anon)).toBe(false)
    expect(launcherAllows('stop', await checkLauncherAuth('Bearer t', ['http://daq:5001'], down))).toBe(true)
  })
  it('tries the next URL when the first is unreachable', async () => {
    let calls = 0
    const f = (async (url: string, init?: RequestInit) => {
      calls++
      if (url.startsWith('http://bad')) throw new TypeError('unreachable')
      return server('good')(url, init)
    }) as unknown as typeof fetch
    const a = await checkLauncherAuth('Bearer good', ['http://bad:5001', 'http://127.0.0.1:5001'], f)
    expect(a.tokenOk).toBe(true)
    expect(calls).toBe(2)
  })
})

// ── L3: login redirect stays on this site ──
describe('safe redirect after login (L3)', () => {
  const o = 'http://daq.lab:3000'
  it('keeps same-site paths with their query and hash', () => {
    expect(safeNextPath('/logbook/?flag=bad', o)).toBe('/logbook/?flag=bad')
    expect(safeNextPath('/tuner#x', o)).toBe('/tuner#x')
  })
  it('refuses anything that could leave the site', () => {
    for (const bad of ['//evil.example', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', '/\u0000/x',
      'https://evil.example/', 'javascript:alert(1)', 'evil', '', null, undefined]) {
      expect(safeNextPath(bad as string, o)).toBe('/dashboard')
    }
  })
})
