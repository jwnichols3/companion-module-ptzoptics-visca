import { InstanceStatus } from '@companion-module/base'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import type { CameraDefinition } from '../cameras/index.js'
import { eventually, timePasses } from './faked-time.js'
import { ModuleUnderTest } from './module-under-test.js'
import { CameraPowerBytes, SyntaxErrorBytes } from '../visca/__tests__/camera-interactions/bytes.js'
import { Cameras, PowerInquiryBytes } from '../visca/__tests__/simulator/cameras.js'
import { type CameraReplies, SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'
import type { Bytes } from '../utils/byte.js'

const ZoomPositionInquiryBytes = [0x81, 0x09, 0x04, 0x47, 0xff]
const FocusPositionInquiryBytes = [0x81, 0x09, 0x04, 0x48, 0xff]
const FocusModeInquiryBytes = [0x81, 0x09, 0x04, 0x38, 0xff]

/** The inquiries of the "Zoom and focus" group that the camera lacks. */
const Lacked = [FocusPositionInquiryBytes, FocusModeInquiryBytes]

/** A zoom position, and the answer that reports it, for the camera to move to. */
const ZoomedTo = 0x1234
const ZoomedToAnswer = [0x90, 0x50, 0x01, 0x02, 0x03, 0x04, 0xff]

/** Longer than the module takes a camera that says it's on to be still waking, and then to give up on an inquiry. */
const LongEnoughToGiveUp = 20_000

// A definition for these tests only, listed with the built-in ones so that a
// connection can choose it: of a camera known to lack the focus inquiries.
vi.mock(import('../cameras/index.js'), async (importOriginal) => {
	const cameras = await importOriginal()
	const lacksFocus: CameraDefinition = {
		...cameras.GenericVisca,
		id: 'lacks-focus',
		label: 'Lacks focus',
		supported: cameras.GenericVisca.supported.filter((id) => id !== 'focus' && id !== 'focus-mode'),
	}
	return { ...cameras, CameraDefinitions: [...cameras.CameraDefinitions, lacksFocus] }
})

function sameBytes(b1: Bytes, b2: Bytes): boolean {
	return String(b1) === String(b2)
}

/** The camera as it would be if it answered the focus inquiries, on or in standby, with a syntax error. */
function lackingFocus({ on, standby }: CameraReplies): CameraReplies {
	const lacking = ({ replies, otherwise }: CameraReplies['on']) => ({
		replies: [
			...replies.filter(({ inquiry }) => !Lacked.some((lacked) => sameBytes(lacked, inquiry))),
			...Lacked.map((inquiry) => ({ inquiry, reply: SyntaxErrorBytes })),
		],
		otherwise,
	})
	return { on: lacking(on), standby: lacking(standby) }
}

/** The camera's answers while on, but with its zoom at `ZoomedTo`. */
function zoomed({ on: { replies, otherwise } }: CameraReplies): CameraReplies['on'] {
	return {
		replies: replies.map(({ inquiry, reply }) => ({
			inquiry,
			reply: sameBytes(inquiry, ZoomPositionInquiryBytes) ? ZoomedToAnswer : reply,
		})),
		otherwise,
	}
}

function timesReceived(camera: SimulatedCamera, message: Bytes): number {
	return camera.received.filter((received) => sameBytes(received, message)).length
}

function noLongerPolled(module: ModuleUnderTest): string[] {
	return module.logs.map(({ message }) => message).filter((message) => message.includes('no longer polling'))
}

describe.each(Cameras)('camera lacks the focus inquiries: $name', ({ replies }) => {
	// Fake only the timers, not the sockets, so that waiting for the camera
	// to be taken as awake takes no real time.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	/** Check that the camera's zoom is still followed, the connection is ok, and Power On reaches the camera. */
	async function expectTheRestKeepsUpdating(module: ModuleUnderTest, camera: SimulatedCamera): Promise<void> {
		expect(module.variable('zoom')).not.toBe(ZoomedTo)
		camera.answerAs(zoomed(lackingFocus(replies)))
		await eventually(() => {
			expect(module.variable('zoom')).toBe(ZoomedTo)
		})
		expect(module.variable('power')).toBe('on')
		expect(module.variable('pan')).toBeTypeOf('number')

		expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])
		expect(module.logs.filter(({ level }) => level === 'warn' || level === 'error')).toEqual([])

		await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
		await eventually(() => {
			expect(camera.received).toContainEqual(CameraPowerBytes)
		})
		expect(module.status).toBe(InstanceStatus.Ok)
	}

	test('Generic VISCA: each inquiry the camera lacks is dropped, said once, and the rest keep updating', async () => {
		const camera = await SimulatedCamera.start({ power: 'on', replies: lackingFocus(replies) })

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: true,
			pollInterval: 500,
			pollGroups: ['power', 'position', 'lens'],
		})
		try {
			await eventually(() => {
				expect(noLongerPolled(module)).toEqual([
					'Camera didn\'t answer the "focus" status inquiry; no longer polling it',
					'Camera didn\'t answer the "focus-mode" status inquiry; no longer polling it',
				])
			}, LongEnoughToGiveUp)
			expect(module.variable('focus')).not.toBeTypeOf('number')

			// Neither is asked again, pass after pass, and neither is said again.
			const refused = Lacked.map((inquiry) => timesReceived(camera, inquiry))
			const passesBefore = timesReceived(camera, PowerInquiryBytes)
			await timePasses(LongEnoughToGiveUp)
			expect(timesReceived(camera, PowerInquiryBytes)).toBeGreaterThan(passesBefore + 10)
			expect(Lacked.map((inquiry) => timesReceived(camera, inquiry))).toEqual(refused)
			expect(noLongerPolled(module)).toHaveLength(Lacked.length)

			await expectTheRestKeepsUpdating(module, camera)
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})

	test('a camera model without them: the inquiries are never sent, nothing is said, and the rest keep updating', async () => {
		const camera = await SimulatedCamera.start({ power: 'on', replies: lackingFocus(replies) })

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			cameraModel: 'lacks-focus',
			pollEnabled: true,
			pollInterval: 500,
			pollGroups: ['power', 'position', 'lens'],
		})
		try {
			await timePasses(LongEnoughToGiveUp)
			expect(timesReceived(camera, PowerInquiryBytes)).toBeGreaterThan(10)
			expect(Lacked.map((inquiry) => timesReceived(camera, inquiry))).toEqual([0, 0])
			expect(noLongerPolled(module)).toEqual([])

			await expectTheRestKeepsUpdating(module, camera)
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})
})
