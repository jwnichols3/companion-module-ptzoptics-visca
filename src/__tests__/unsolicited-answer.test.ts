import { InstanceStatus } from '@companion-module/base'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import { eventually, timePasses } from './faked-time.js'
import { ModuleUnderTest } from './module-under-test.js'
import { CameraPowerBytes } from '../visca/__tests__/camera-interactions/bytes.js'
import { Cameras, PowerInquiryBytes } from '../visca/__tests__/simulator/cameras.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'
import type { Bytes } from '../utils/byte.js'

/** How many inquiries a poll pass of the power, position and lens groups sends. */
const InquiriesPerPass = 5

const PollInterval = 1000

/**
 * An answer nothing asked for.  Taken for the answer to the power inquiry it
 * would read standby, and to the focus mode inquiry, manual.
 */
const StrayAnswer = [0x90, 0x50, 0x03, 0xff]

function timesReceived(camera: SimulatedCamera, message: Bytes): number {
	return camera.received.filter((received) => String(received) === String(message)).length
}

function errorsLogged(module: ModuleUnderTest): string[] {
	return module.logs.filter(({ level }) => level === 'error').map(({ message }) => message)
}

// A camera that has just woken may send answers to inquiries it was sent
// while waking.  One that arrives while an inquiry is unanswered can't be
// told from that inquiry's answer.  One that arrives while nothing at all is
// unanswered can, and must go no further.

describe.each(Cameras)('camera sends an answer nothing asked for, between poll passes: $name', ({ replies }) => {
	// Fake only the timers, not the sockets, so that the waits between poll
	// passes take no real time, and the answer can be sent during one.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	test('the answer is ignored: values stay right, the connection stays ok, and Power On reaches the camera', async () => {
		const camera = await SimulatedCamera.start({ power: 'on', replies })

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: true,
			pollInterval: PollInterval,
			pollGroups: ['power', 'position', 'lens'],
		})
		try {
			await eventually(() => {
				expect(typeof module.variable('focus_mode')).toBe('string')
				expect(module.variable('focus_mode')).not.toBe('')
			})
			const values = () =>
				['power', 'pan', 'tilt', 'zoom', 'focus', 'focus_mode'].map((id) => [id, module.variable(id)])
			const valuesBefore = values()
			expect(valuesBefore).toContainEqual(['power', 'on'])

			// Well into the wait between two passes, every inquiry sent has
			// been answered.
			await timePasses(PollInterval / 2)
			const receivedBefore = camera.received.length
			expect(receivedBefore % InquiriesPerPass).toBe(0)

			camera.send(StrayAnswer)
			await eventually(() => {
				expect(module.logs).toContainEqual({
					level: 'debug',
					message: 'Ignoring unsolicited inquiry response [90 50 03 FF]',
				})
			})
			// Nothing was asked meanwhile for it to be the answer to.
			expect(camera.received.length).toBe(receivedBefore)

			// Had the answer been kept for the next inquiry, every answer
			// since would have gone to the inquiry after its own.
			const passesBefore = timesReceived(camera, PowerInquiryBytes)
			await eventually(() => {
				expect(timesReceived(camera, PowerInquiryBytes)).toBeGreaterThan(passesBefore + 3)
				expect(values()).toEqual(valuesBefore)
			})
			await timePasses(PollInterval / 2)
			expect(values()).toEqual(valuesBefore)
			expect(module.logs.filter(({ message }) => message.includes('no longer polling'))).toEqual([])
			expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])
			expect(errorsLogged(module)).toEqual([])

			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
			await eventually(() => {
				expect(camera.received).toContainEqual(CameraPowerBytes)
			})
			expect(module.status).toBe(InstanceStatus.Ok)
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})
})
