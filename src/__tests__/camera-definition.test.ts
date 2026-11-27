import { InstanceStatus } from '@companion-module/base'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { CameraDefinition } from '../cameras/index.js'
import { eventually } from './faked-time.js'
import { ModuleUnderTest } from './module-under-test.js'
import { Cameras, PowerInquiryBytes } from '../visca/__tests__/simulator/cameras.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'
import type { Bytes } from '../utils/byte.js'

const PanTiltPositionInquiryBytes = [0x81, 0x09, 0x06, 0x12, 0xff]
const ZoomPositionInquiryBytes = [0x81, 0x09, 0x04, 0x47, 0xff]

/** How many poll passes the module must get through. */
const PollPasses = 10

// A definition for these tests only, listed with the built-in ones so that a
// connection can choose it.  It lacks the focus inquiries of the "Zoom and
// focus" group, and still asks for zoom of a camera in standby.
vi.mock(import('../cameras/index.js'), async (importOriginal) => {
	const cameras = await importOriginal()
	const testCamera: CameraDefinition = {
		id: 'test-camera',
		label: 'Test camera',
		supported: ['power', 'pan-tilt', 'zoom', 'exposure-mode'],
		standby: ['power', 'zoom'],
		ranges: { zoomMax: 0x2000 },
		wakeWindowMs: 60_000,
		quirks: [],
		captures: [],
	}
	return { ...cameras, CameraDefinitions: [...cameras.CameraDefinitions, testCamera] }
})

/** A camera that answers every inquiry, on or in standby, so that an inquiry it never receives was never sent. */
function cameraAnsweringEverything() {
	const camera = Cameras.find(({ name }) => name === 'ptzoptics (captured)')
	if (camera === undefined) {
		throw new Error('The captures of the PTZOptics camera are missing')
	}
	return camera.replies
}

/** The zoom position the captured camera reports in the given power state. */
function capturedZoom(power: 'on' | 'standby'): number {
	const answer = cameraAnsweringEverything()[power].replies.find(
		({ inquiry }) => String(inquiry) === String(ZoomPositionInquiryBytes),
	)
	if (answer === undefined) {
		throw new Error('The captures of the PTZOptics camera lack the zoom position')
	}
	// `90 50 0p 0q 0r 0s FF`
	const [, , p, q, r, s] = answer.reply
	return (p << 12) | (q << 8) | (r << 4) | s
}

function inquiriesReceived(camera: SimulatedCamera): Set<string> {
	return new Set(camera.received.map((message: Bytes) => String(message)))
}

describe('camera model other than Generic VISCA', () => {
	// Fake only the timers, not the sockets, so that the waits between poll
	// passes take no real time.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	test('powered on: an inquiry the definition lacks is never sent, nor one of a group not selected', async () => {
		const camera = await SimulatedCamera.start({ power: 'on', replies: cameraAnsweringEverything() })

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			cameraModel: 'test-camera',
			pollEnabled: true,
			pollInterval: 100,
			// The definition has the exposure mode inquiry, but its group isn't selected.
			pollGroups: ['power', 'position', 'lens'],
		})
		try {
			await eventually(() => {
				expect(camera.received.length).toBeGreaterThanOrEqual(3 * PollPasses)
			})

			expect(inquiriesReceived(camera)).toEqual(
				new Set([PowerInquiryBytes, PanTiltPositionInquiryBytes, ZoomPositionInquiryBytes].map(String)),
			)
			expect(module.variable('power')).toBe('on')
			expect(module.variable('zoom')).toBeTypeOf('number')
			expect(module.logs.filter(({ message }) => message.includes('no longer polling'))).toEqual([])
			expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})

	test("in standby: the definition's standby inquiries are sent, and no others", async () => {
		const camera = await SimulatedCamera.start({ power: 'standby', replies: cameraAnsweringEverything() })

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			cameraModel: 'test-camera',
			pollEnabled: true,
			pollInterval: 100,
			pollGroups: ['power', 'position', 'lens'],
		})
		try {
			await eventually(() => {
				expect(camera.received.length).toBeGreaterThanOrEqual(2 * PollPasses)
			})

			expect(inquiriesReceived(camera)).toEqual(new Set([PowerInquiryBytes, ZoomPositionInquiryBytes].map(String)))
			expect(module.variable('power')).toBe('standby')
			expect(module.variable('zoom')).toBe(capturedZoom('standby'))
			expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})

	test("the full-telephoto zoom position is the definition's when none is entered", async () => {
		const camera = await SimulatedCamera.start({ power: 'on', replies: cameraAnsweringEverything() })

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			cameraModel: 'test-camera',
			pollEnabled: true,
			pollInterval: 100,
		})
		try {
			await eventually(() => {
				expect(module.variable('zoom')).toBeTypeOf('number')
			})

			// A percentage of the definition's range of 0x2000, twice what it
			// would be of the Generic VISCA range of 0x4000.
			const zoom = capturedZoom('on')
			expect(module.variable('zoom')).toBe(zoom)
			expect(module.variable('zoom_pct')).toBe(Math.min(100, Math.round((100 * zoom) / 0x2000)))
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})
})
