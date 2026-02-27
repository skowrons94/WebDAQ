// ─── Grafana Configuration (used for external links only) ────────────────────
export const GRAFANA_URL = "http://lunaserver:3000"

// All API calls go through the Next.js proxy at /api/grafana to avoid CORS.
const grafanaFetch = async (path: string, options: RequestInit = {}) => {
  // Strip leading slash so we can build /api/grafana/<path>
  const proxyPath = path.startsWith('/') ? path.slice(1) : path
  const res = await fetch(`/api/grafana/${proxyPath}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    },
  })
  if (!res.ok) throw new Error(`Grafana API error: ${res.status}`)
  return res.json()
}

// ─── Alert rule helpers ───────────────────────────────────────────────────────
export const fetchAlertRules = () =>
  grafanaFetch("/api/v1/provisioning/alert-rules")

export const setAlertPauseState = async (ruleUid: string, isPaused: boolean) => {
  const rule = await grafanaFetch(`/api/v1/provisioning/alert-rules/${ruleUid}`)
  rule.isPaused = isPaused
  return grafanaFetch(`/api/v1/provisioning/alert-rules/${ruleUid}`, {
    method: "PUT",
    body: JSON.stringify(rule),
  })
}

/**
 * Extracts the first numeric threshold found in a Grafana alert rule's
 * classic conditions (evaluator.params[0]).  Returns null if not present.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractThreshold(rule: any): number | null {
  for (const q of rule.data || []) {
    for (const cond of q.model?.conditions || []) {
      if (Array.isArray(cond.evaluator?.params) && cond.evaluator.params.length > 0) {
        const v = Number(cond.evaluator.params[0])
        if (!isNaN(v)) return v
      }
    }
  }
  return null
}

/**
 * Fetches the full rule, sets evaluator.params[0] on every classic condition
 * to `threshold`, then PUTs the rule back.
 */
export const updateAlertThreshold = async (ruleUid: string, threshold: number) => {
  const rule = await grafanaFetch(`/api/v1/provisioning/alert-rules/${ruleUid}`)
  let updated = false
  for (const q of rule.data || []) {
    for (const cond of q.model?.conditions || []) {
      if (Array.isArray(cond.evaluator?.params) && cond.evaluator.params.length > 0) {
        cond.evaluator.params[0] = threshold
        updated = true
      }
    }
  }
  if (!updated) throw new Error('No editable threshold found in this rule')
  return grafanaFetch(`/api/v1/provisioning/alert-rules/${ruleUid}`, {
    method: 'PUT',
    body: JSON.stringify(rule),
  })
}

export const pauseAlertNonBlocking = (ruleUid: string) => {
  setAlertPauseState(ruleUid, true).catch((e) =>
    console.warn(`Failed to pause alert ${ruleUid}:`, e)
  )
}

export const unpauseAlertNonBlocking = (ruleUid: string) => {
  setAlertPauseState(ruleUid, false).catch((e) =>
    console.warn(`Failed to unpause alert ${ruleUid}:`, e)
  )
}
