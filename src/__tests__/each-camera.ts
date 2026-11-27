import { describe, test } from 'vitest'
import type { CameraPowerState } from '../camera/power.js'
import { type Camera, Cameras, recordedIn } from '../visca/__tests__/simulator/cameras.js'

/** Say a power state the way a sentence about a camera does: "on", "in standby". */
export function stateInWords(power: CameraPowerState): string {
	return power === 'on' ? 'on' : 'in standby'
}

/**
 * Run a scenario against every camera the simulated camera can play that was
 * recorded in every power state the scenario puts a camera in.
 *
 * A camera recorded in only one power state can't be played in the other, so
 * a scenario that needs the other isn't run against it.  It's listed as
 * skipped instead, with the state that wasn't recorded, so that what wasn't
 * tested shows in every run.
 *
 * @param title
 *    Names the scenario.  The camera's name is added to it.
 * @param states
 *    Every power state a camera is in at some time in the scenario.
 * @param scenario
 *    Defines the scenario's tests for one camera, as the function passed to
 *    `describe` does.
 */
export function describeEachCamera<Recorded extends CameraPowerState>(
	title: string,
	states: readonly Recorded[],
	scenario: (camera: Camera<Recorded>) => void,
): void {
	for (const camera of Cameras) {
		describe(`${title}: ${camera.name}`, () => {
			if (recordedIn(camera, states)) {
				scenario(camera)
				return
			}

			const missing = states.filter((state) => camera.replies[state] === undefined)
			test.skip(`not run: the camera wasn't recorded ${missing.map(stateInWords).join(' or ')}`, () => {})
		})
	}
}
