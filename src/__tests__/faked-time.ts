import { vi } from 'vitest'

/** How much faked time goes by between chances for the sockets to do their work. */
const StepMs = 10

/**
 * Let the given number of milliseconds of faked time go by.
 *
 * For tests that fake only the timers, not the sockets.  Time goes by in
 * small steps, and between steps whatever the sockets have to deliver is
 * delivered, so a minute of the module polling a simulated camera takes a
 * fraction of a second.
 */
export async function timePasses(ms: number): Promise<void> {
	for (let passed = 0; passed < ms; passed += StepMs) {
		vi.advanceTimersByTime(StepMs)
		await new Promise((resolve) => {
			setImmediate(resolve)
		})
	}
}

/**
 * Check the assertion again and again, letting faked time go by as
 * `timePasses` does between checks, until it passes.
 *
 * Does what `vi.waitFor` does, but that lets faked time go by no faster than
 * real time.
 *
 * @throws
 *    What the assertion throws, if it still doesn't pass after `limitMs` of
 *    faked time.
 */
export async function eventually(assertion: () => void, limitMs = 5000): Promise<void> {
	for (let passed = 0; ; passed += StepMs) {
		try {
			assertion()
			return
		} catch (e) {
			if (passed >= limitMs) {
				throw e
			}
		}
		await timePasses(StepMs)
	}
}
