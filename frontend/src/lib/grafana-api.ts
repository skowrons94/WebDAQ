import axios from 'axios'
import api from '@/lib/api'

// Grafana is reached through the WebDAQ server (/grafana/...), which holds the
// Grafana address and service-account token — see Settings → Grafana.
const grafanaFetch = async (path: string, options: { method?: 'GET' | 'PUT'; body?: unknown } = {}) => {
  try {
    const res = await api.request({
      url: `/grafana${path}`,
      method: options.method ?? 'GET',
      data: options.body,
    })
    return res.data
  } catch (e: unknown) {
    // Surface the server's explanation (unreachable, token rejected, …).
    if (axios.isAxiosError(e) && e.response?.data?.error) throw new Error(e.response.data.error)
    throw e
  }
}

// ─── Alert rule helpers ───────────────────────────────────────────────────────
export const fetchAlertRules = () =>
  grafanaFetch("/alert-rules")

export const setAlertPauseState = async (ruleUid: string, isPaused: boolean) => {
  const rule = await grafanaFetch(`/alert-rules/${ruleUid}`)
  rule.isPaused = isPaused
  return grafanaFetch(`/alert-rules/${ruleUid}`, {
    method: "PUT",
    body: rule,
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
  const rule = await grafanaFetch(`/alert-rules/${ruleUid}`)
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
  return grafanaFetch(`/alert-rules/${ruleUid}`, {
    method: 'PUT',
    body: rule,
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
