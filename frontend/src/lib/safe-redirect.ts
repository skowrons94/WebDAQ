/**
 * Where to go after login: only a path on this site. Anything else (another
 * origin, "//host", "/\\host", control characters or tabs that the URL parser
 * would strip into "//host") falls back to `fallback`.
 */
export function safeNextPath(target: string | null | undefined, origin: string, fallback = '/dashboard'): string {
  if (!target) return fallback
  if (!target.startsWith('/') || target.startsWith('//') || target.startsWith('/\\')) return fallback
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(target)) return fallback
  try {
    const url = new URL(target, origin)
    if (url.origin !== new URL(origin).origin) return fallback
    return url.pathname + url.search + url.hash
  } catch {
    return fallback
  }
}
