/** Position readings the tracker compares. */
type Position = { pan: number; tilt: number; zoom: number }

/** How far a polled position may drift and still count as "at the preset". */
const Tolerance = { pan: 2, tilt: 2, zoom: 16 }

/** Ignore position changes for this long after a recall: the camera is still moving there. */
const MinSettleMs = 1000

/**
 * Remembers which preset this module last recalled, and forgets it once the
 * camera has been moved away from that preset (e.g. by a joystick or another
 * controller).  The camera itself can't report which preset is active.
 *
 * After a recall, the tracker waits until two consecutive polled positions are
 * equal (the camera has arrived), records that position, then clears the
 * preset when a later position differs by more than a small tolerance.
 * Without position polling, the preset is kept until the next recall.
 */
export class PresetTracker {
	#preset: number | null = null
	#recalledAt = 0
	#previous: Position | null = null
	#home: Position | null = null

	get current(): number | null {
		return this.#preset
	}

	recalled(preset: number, now: number): void {
		this.#preset = preset
		this.#recalledAt = now
		this.#previous = null
		this.#home = null
	}

	/**
	 * Note a newly polled position.
	 * @returns true if the current preset changed (was cleared).
	 */
	position(pos: Position, now: number): boolean {
		if (this.#preset === null) return false

		if (this.#home === null) {
			const settled = this.#previous !== null && near(this.#previous, pos, { pan: 0, tilt: 0, zoom: 0 })
			this.#previous = pos
			if (settled && now - this.#recalledAt >= MinSettleMs) this.#home = pos
			return false
		}

		if (near(this.#home, pos, Tolerance)) return false
		this.#preset = null
		this.#home = null
		this.#previous = null
		return true
	}
}

function near(a: Position, b: Position, tol: Position): boolean {
	return (
		Math.abs(a.pan - b.pan) <= tol.pan && Math.abs(a.tilt - b.tilt) <= tol.tilt && Math.abs(a.zoom - b.zoom) <= tol.zoom
	)
}
