// Unit tests of the Tuner's pure functions. The frontend has no test runner
// of its own (package.json is unchanged), so run them with a vitest fetched
// on the fly, from frontend/:
//   npx vitest@2 run -c tests/unit/vitest.config.mts
// Type-check them with: npx tsc --noEmit -p tests/unit
// (a plain object, so the config itself needs no installed package)
import { fileURLToPath } from 'node:url'

export default {
  resolve: { alias: { '@': fileURLToPath(new URL('../../src', import.meta.url)) } },
  test: { include: ["tests/unit/**/*.test.ts"], environment: "node" },
}
