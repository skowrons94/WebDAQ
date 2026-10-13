// The part of vitest's API the unit tests use, so `tsc -p tests/unit` checks
// them without vitest installed in the app.
declare module 'vitest' {
  interface Matchers {
    toBe(v: unknown): void
    toEqual(v: unknown): void
    toBeNull(): void
    toBeCloseTo(v: number, digits?: number): void
    toBeGreaterThan(v: number): void
    toBeGreaterThanOrEqual(v: number): void
    toBeLessThan(v: number): void
    toHaveLength(n: number): void
    toMatch(r: RegExp | string): void
    not: Matchers
  }
  export function describe(name: string, fn: () => void): void
  export function it(name: string, fn: () => void | Promise<void>): void
  export function expect(v: unknown): Matchers
}
