import { defineConfig } from 'vitest/config'

// The stress tests: long soaks and injected faults, run by `yarn test:stress`
// apart from the tests `yarn test` runs.
export default defineConfig({
	test: {
		include: ['src/**/*.stress.ts'],
		exclude: ['**/node_modules/**', '**/dist/**'],
		// Each test is a long run, in compressed time.
		testTimeout: 5 * 60 * 1000,
		// Let the soak collect garbage before it measures memory in use.
		execArgv: ['--expose-gc'],
	},
})
