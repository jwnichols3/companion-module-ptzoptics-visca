/** Turns within this long of each other add up, rather than restarting from the polled position. */
const AccumulateMs = 1000

/**
 * Computes zoom targets for relative zoom steps (e.g. a Stream Deck + knob).
 *
 * Fast knob turns arrive faster than status polls, so each step builds on the
 * last target while turns keep coming, and on the polled position once the
 * knob has been idle.
 */
export class ZoomTarget {
	#last: number | null = null
	#lastAt = 0

	/**
	 * @param percent  Signed step, in percent of the full zoom range.
	 * @param polled   The latest polled zoom position, if known.
	 * @param zoomMax  The zoom position at full telephoto.
	 * @returns The absolute position to zoom to, or null if the start position is unknown.
	 */
	step(percent: number, polled: number | undefined, zoomMax: number, now: number): number | null {
		const base = this.#last !== null && now - this.#lastAt < AccumulateMs ? this.#last : polled
		if (base === undefined) return null
		return this.#set(base + (percent * zoomMax) / 100, zoomMax, now)
	}

	/** Target an absolute percentage of the zoom range. */
	toPercent(percent: number, zoomMax: number, now: number): number {
		return this.#set((percent * zoomMax) / 100, zoomMax, now)
	}

	#set(position: number, zoomMax: number, now: number): number {
		const p = Math.round(Math.min(zoomMax, Math.max(0, position)))
		this.#last = p
		this.#lastAt = now
		return p
	}
}
