'use client'

import { useEffect } from 'react'
import { create } from 'zustand'

import { getAlertRules, getRecoveryActions, type RecoveryAction } from '@/lib/api'

/**
 * Whether anything would tell the shift that something went wrong.
 *
 * An empty bell and an all-green overview read as "all quiet", which is only
 * true if the watcher is running and an alert has somewhere to go. When it is
 * not (server started without its watcher, no Telegram or Zulip set up) the
 * bell, the overview and /alerts say so, from this one poller.
 *
 * It also carries what Troubleshoot calls "needs attention" (Graphite not
 * answering, a monitor that stopped), so that is not only visible on a page
 * nobody opens at 03:00.
 */

const POLL_MS = 30_000

export interface AlertingProblem {
  /** Short, for the bell and the overview strip. */
  title: string
  detail: string
  href: string
  linkLabel: string
}

interface AlertingHealthState {
  known: boolean
  watching: boolean
  /** Telegram/Zulip destinations that are switched on and configured. */
  destinations: string[]
  enabledRules: number
  /** Enabled rules whose destinations are all off or unconfigured. */
  undeliverableRules: number
  /** Troubleshoot's subsystems that do not answer (same rule as that page). */
  attention: RecoveryAction[]
  update: (patch: Partial<Omit<AlertingHealthState, 'update'>>) => void
}

const useAlertingHealthStore = create<AlertingHealthState>((set) => ({
  known: false,
  watching: false,
  destinations: [],
  enabledRules: 0,
  undeliverableRules: 0,
  attention: [],
  update: (patch) => set(patch),
}))

/** Troubleshoot's own filter: only blocked or not installed is not a problem. */
export function needsAttention(actions: RecoveryAction[]): RecoveryAction[] {
  return actions.filter((a) => !a.ok && a.enabled
    && !a.detail.toLowerCase().includes('no beam-current monitor'))
}

async function pollOnce() {
  const store = useAlertingHealthStore.getState()
  const [rules, recovery] = await Promise.allSettled([getAlertRules(), getRecoveryActions()])
  const patch: Partial<AlertingHealthState> = {}
  if (rules.status === 'fulfilled') {
    const { status, rules: list } = rules.value
    const ready = status.transports_ready ?? {}
    const enabled = list.filter((r) => r.enabled)
    const deliverable = new Map(status.rules.map((r) => [r.id, r.deliverable]))
    patch.known = true
    patch.watching = Boolean(status.watching)
    patch.destinations = Object.entries(ready).filter(([, ok]) => ok).map(([name]) => name)
    patch.enabledRules = enabled.length
    patch.undeliverableRules = enabled.filter((r) => deliverable.get(r.id) === false).length
  }
  if (recovery.status === 'fulfilled') {
    // Graphite is optional (many setups have none): Troubleshoot still shows
    // it, but the dashboard and the bell do not raise it as a problem.
    patch.attention = needsAttention(recovery.value.actions).filter((a) => a.name !== 'graphite')
  }
  // No answer at all: keep what was last known. The header must never be the
  // thing that breaks, and the run status already says "No answer".
  store.update(patch)
}

let subscribers = 0
let timer: ReturnType<typeof setInterval> | null = null

function subscribe() {
  subscribers += 1
  if (subscribers === 1) {
    void pollOnce().catch(() => undefined)
    timer = setInterval(() => { void pollOnce().catch(() => undefined) }, POLL_MS)
  }
  return () => {
    subscribers -= 1
    if (subscribers === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

/** Ask again now (after Start watching, or a destination was saved). */
export function refreshAlertingHealth(): Promise<void> {
  return pollOnce().catch(() => undefined)
}

const NOTIFICATIONS = '/settings?view=notifications'
// The watcher switch and the rules are in the Alerts card at the bottom of a
// long page (under the Telegram and Zulip forms): link straight to it.
const ALERTS_CARD = `${NOTIFICATIONS}#alerts`

/** What is wrong with alerting itself, most serious first; empty when fine. */
export function alertingProblems(s: Pick<AlertingHealthState,
  'known' | 'watching' | 'destinations' | 'enabledRules' | 'undeliverableRules'>): AlertingProblem[] {
  if (!s.known) return []
  if (!s.watching) {
    return [{
      title: 'Alerts are off',
      detail: 'Nothing is watching the run, so no alert can be raised.',
      href: ALERTS_CARD,
      linkLabel: 'Settings → Notifications',
    }]
  }
  if (s.destinations.length === 0) {
    return [{
      title: 'Alerts reach nobody',
      detail: 'No Telegram or Zulip destination is set up.',
      href: NOTIFICATIONS,
      linkLabel: 'Settings → Notifications',
    }]
  }
  if (s.enabledRules === 0) {
    return [{
      title: 'No alert is set up',
      detail: 'No rule is switched on, so nothing will be sent.',
      href: ALERTS_CARD,
      linkLabel: 'Settings → Notifications',
    }]
  }
  if (s.undeliverableRules > 0) {
    return [{
      title: `${s.undeliverableRules} alert${s.undeliverableRules === 1 ? '' : 's'} reach nobody`,
      detail: 'Their destinations are off or not configured.',
      href: ALERTS_CARD,
      linkLabel: 'Settings → Notifications',
    }]
  }
  return []
}

export function useAlertingHealth() {
  useEffect(subscribe, [])
  const state = useAlertingHealthStore()
  const problems = alertingProblems(state)
  return { ...state, problems }
}
