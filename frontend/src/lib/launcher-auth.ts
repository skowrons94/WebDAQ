/**
 * Who may use the launcher route (app/api/server-control). The route runs in
 * the Next.js process and can start and stop the DAQ server, so:
 *
 *  - While the DAQ server is up, the caller must hold a token the server
 *    accepts (its own GET /protected, with the same bearer token the app sends
 *    to every other request). Without one: 401.
 *  - While the server is down nothing can verify a token (the server issues
 *    and checks them), and the login page must be able to start it. So "start"
 *    and the launch log stay open then; "stop" still needs a bearer token,
 *    and only ever stops the launcher's own server process.
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

/**
 * Ask the DAQ server whether the caller's token is good. `urls` are the
 * server's base URLs to try in turn (the configured one, then loopback).
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
    } catch {
      // Not reachable at this URL: try the next.
    }
  }
  return { backendUp: false, tokenOk: false, hasToken: !!token }
}

/** Whether an action is allowed under these rules (see the module comment). */
export function launcherAllows(action: 'start' | 'stop' | 'logs' | 'status', a: LauncherAuth): boolean {
  switch (action) {
    case 'status': return true // running flag, directory, test mode: nothing secret
    case 'start': return a.backendUp ? a.tokenOk : true
    case 'logs': return a.backendUp ? a.tokenOk : true
    case 'stop': return a.backendUp ? a.tokenOk : a.hasToken
  }
}
