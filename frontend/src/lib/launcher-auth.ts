/**
 * Who may use the launcher route (app/api/server-control). The route runs in
 * the Next.js process and can start and stop the DAQ server, so:
 *
 *  - While the DAQ server is up, the caller must hold a token the server
 *    accepts (its own GET /protected, with the same bearer token the app sends
 *    to every other request). Without one: 401.
 *  - While the server is down nothing can verify a token (the server issues
 *    and checks them), and the login page must be able to start it. So "start"
 *    and the launch log stay open then. "Stop" always needs an accepted token,
 *    and only ever stops the launcher's own server process.
 *  - "Down" means refused: every address refused the connection (nothing
 *    listens). A server that does not answer in time (stalled, or flooded by
 *    someone on the network) is UP for these rules, with the token not
 *    accepted — never a reason to open start, or to reap the port.
 */
export interface LauncherAuth {
  /** The DAQ server answered. */
  backendUp: boolean
  /** The bearer token was accepted by it. */
  tokenOk: boolean
  /** A bearer token was sent at all. */
  hasToken: boolean
}

export function bearerToken(authorization: string | null | undefined): string | null {
  const m = authorization?.match(/^Bearer\s+(\S+)\s*$/i)
  return m ? m[1] : null
}

/** Connection-level errors that mean "nothing is there" (as opposed to a timeout). */
const DOWN_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EADDRNOTAVAIL'])

/** Whether a fetch error says the address refused (nothing listening), not that it was slow. */
export function isRefused(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string; errors?: { code?: string }[] } } | null
  const codes = [e?.code, e?.cause?.code, ...(e?.cause?.errors ?? []).map((x) => x?.code)]
  return codes.some((c) => !!c && DOWN_CODES.has(c))
}

/**
 * Ask the DAQ server whether the caller's token is good. `urls` are the
 * server's base URLs to try in turn (the configured one, then loopback).
 * Down only when every address refused; a timeout or any other failure
 * counts as up with the token not accepted.
 */
export async function checkLauncherAuth(
  authorization: string | null | undefined,
  urls: string[],
  fetchFn: typeof fetch = fetch,
  timeoutMs = 2000,
): Promise<LauncherAuth> {
  const token = bearerToken(authorization)
  for (const base of urls) {
    try {
      const res = await fetchFn(`${base.replace(/\/+$/, '')}/protected`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(timeoutMs),
      })
      // Any answer means the server is up; only 200 accepts the token.
      return { backendUp: true, tokenOk: !!token && res.status === 200, hasToken: !!token }
    } catch (error) {
      // Refused here: try the next address. Anything else (a timeout above
      // all): the server may be up and stalled -- fail closed.
      if (!isRefused(error)) return { backendUp: true, tokenOk: false, hasToken: !!token }
    }
  }
  return { backendUp: false, tokenOk: false, hasToken: !!token }
}

/**
 * Whether a process runs this installation's main.py: an argument that is
 * main.py and resolves (against the process's working directory) to `mainPy`.
 * `realpath` resolves symlinks; it defaults to the identity.
 */
export function runsMainPy(args: string[], cwd: string | null, mainPy: string, realpath: (p: string) => string = (p) => p): boolean {
  const want = realpath(mainPy)
  return args.some((a) => {
    if (!/(^|\/)main\.py$/.test(a)) return false
    const abs = a.startsWith('/') ? a : cwd ? `${cwd.replace(/\/+$/, '')}/${a.replace(/^\.\//, '')}` : null
    if (!abs) return false
    try { return realpath(abs) === want } catch { return false }
  })
}

/** Whether an action is allowed under these rules (see the module comment). */
export function launcherAllows(action: 'start' | 'stop' | 'logs' | 'status', a: LauncherAuth): boolean {
  switch (action) {
    case 'status': return true // running flag, directory, test mode: nothing secret
    case 'start': return a.backendUp ? a.tokenOk : true
    case 'logs': return a.backendUp ? a.tokenOk : true
    case 'stop': return a.tokenOk
  }
}
