import type { CameraDefinition } from './definition.js'

/** Every inquiry the module can poll: the camera answers them all. */
const Answered = [
	'power',
	'pan-tilt',
	'zoom',
	'focus',
	'focus-mode',
	'exposure-mode',
	'iris',
	'shutter',
	'gain',
	'brightness',
	'wb-mode',
	'wb-red',
	'wb-blue',
	'flip',
	'mirror',
	'color_temp',
	'r_tuning',
	'b_tuning',
	'saturation',
	'hue',
	'contrast',
	'luminance',
	'sharpness',
	'exp_comp',
]

/**
 * The PTZOptics 20X whose VISCA version reply gives model code F64.HI, as
 * captured with firmware SOC v9.1.34.
 *
 * In standby the camera answers every inquiry as readily as when on, with
 * where it's parked and the settings it will wake with, so everything goes on
 * being polled: the values shown are the camera's own, not the last ones seen
 * before it slept.
 *
 * The captures don't show the camera at full telephoto, so its zoom range is
 * the Generic VISCA one, which no captured position exceeds.
 *
 * Told to power on, the camera acknowledges, then answers nothing for about
 * 31 seconds, refusing connections for about 11 of them.  The wake window
 * allows half as long again.
 */
export const PtzOptics20xF64Hi: CameraDefinition = {
	id: 'ptzoptics-20x-f64hi',
	label: 'PTZOptics 20X (F64.HI)',
	supported: Answered,
	standby: Answered,
	ranges: { zoomMax: 0x4000 },
	wakeWindowMs: 45_000,
	quirks: [],
	captures: ['ptzoptics/on', 'ptzoptics/standby', 'ptzoptics/waking'],
}
