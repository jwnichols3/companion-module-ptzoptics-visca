import type { CameraDefinition } from './definition.js'
import { PollGroups } from '../status/groups.js'

/**
 * Any camera that speaks VISCA over IP, with nothing assumed of it: every
 * inquiry is tried, and one the camera doesn't answer is dropped.
 *
 * Some cameras answer every inquiry in standby and others refuse all but
 * power, so only power is asked of a camera in standby.
 *
 * Nothing is known of how long a camera takes to wake.  The slowest wake-up
 * captured so far took about half a minute, so allow twice that.
 */
export const GenericVisca: CameraDefinition = {
	id: 'generic-visca',
	label: 'Generic VISCA',
	supported: PollGroups.flatMap((g) => g.inquiries.map(({ id }) => id)),
	standby: ['power'],
	ranges: { zoomMax: 0x4000 },
	wakeWindowMs: 60_000,
	quirks: [],
	// No one camera's captures can back what is assumed of every camera.
	captures: [],
}
