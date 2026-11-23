/** Steps within this long of each other add up, rather than restarting from the polled value. */
const AccumulateMs = 1000

/**
 * Computes targets for relative steps of a bounded setting (e.g. a Stream Deck + knob).
 *
 * Fast knob turns arrive faster than status polls, so each step builds on the
 * last target while turns keep coming, and on the polled value once the knob
 * has been idle.  One target is kept per key.
 */
export class ValueTargets {
	#last = new Map<string, { value: number; at: number }>()

	/** @returns The new absolute value, or null if the start value is unknown. */
	step(key: string, delta: number, polled: number | undefined, min: number, max: number, now: number): number | null {
		const last = this.#last.get(key)
		const base = last !== undefined && now - last.at < AccumulateMs ? last.value : polled
		if (base === undefined) return null
		return this.set(key, base + delta, min, max, now)
	}

	/** Target an absolute value, clamped to the range. */
	set(key: string, value: number, min: number, max: number, now: number): number {
		const v = Math.round(Math.min(max, Math.max(min, value)))
		this.#last.set(key, { value: v, at: now })
		return v
	}
}
