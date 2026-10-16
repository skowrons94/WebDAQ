/**
 * Steps that follow a successful start (or stop) and must never undo it: each
 * runs on its own, a failure becomes a warning for the operator, and the next
 * step still runs.
 */
export interface SideEffect {
  /** What to tell the operator when it fails ("the run name … was not saved"). */
  warning: string
  run: () => unknown | Promise<unknown>
}

/** Run each step in turn; return the warnings of those that failed. */
export async function runSideEffects(steps: (SideEffect | false | null | undefined)[]): Promise<string[]> {
  const warnings: string[] = []
  for (const step of steps) {
    if (!step) continue
    try {
      await step.run()
    } catch (error) {
      console.error(`${step.warning}:`, error)
      warnings.push(step.warning)
    }
  }
  return warnings
}
