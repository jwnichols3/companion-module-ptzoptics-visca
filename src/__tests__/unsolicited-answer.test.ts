import { InstanceStatus } from '@companion-module/base'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import { describeEachCamera } from './each-camera.js'
import { eventually, timePasses } from './faked-time.js'
import { ModuleUnderTest } from './module-under-test.js'
import { CameraPowerBytes } from '../visca/__tests__/camera-interactions/bytes.js'
import { PowerInquiryBytes } from '../visca/__tests__/simulator/cameras.js'
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

describeEachCamera('camera sends an answer nothing asked for, between poll passes', ['on'], ({ replies }) => {
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

// An answer is never the response to a command.  So one that arrives while
// no inquiry is unanswered is the answer to nothing, even if a command sent
// meanwhile hasn't been acknowledged yet.  Taken for a sign that the module
// and the camera had lost track of each other, it once closed the connection
// for good, until someone disabled and enabled it.  The fault injection run
// found this, from seed 1232023764: an answer sent too late, after the answer
// to the probe sent after its inquiry, arrived just as a button was pressed.

describeEachCamera(
	'camera sends an answer nothing asked for, while a command awaits its acknowledgement',
	['on', 'standby'],
	({ replies: { on, standby } }) => {
		// How a camera wakes is for other scenarios: this one is on as soon as
		// it's told to be.
		const replies = { on, standby }

		const PowerStandbyBytes = [0x81, 0x01, 0x04, 0x00, 0x03, 0xff]

		// Fake only the timers, not the sockets, so that the waits between
		// poll passes take no real time, and the answer can be sent during
		// one.
		beforeEach(() => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		})
		afterEach(() => {
			vi.useRealTimers()
		})

		test('the answer is ignored: the command is carried out, the power variable follows, and the connection stays ok', async () => {
			const camera = await SimulatedCamera.start({ power: 'on', replies })

			// Every setting but these takes its default.
			const module = await ModuleUnderTest.start({
				host: '127.0.0.1',
				port: String(camera.port),
				pollEnabled: true,
			})
			try {
				await eventually(() => {
					expect(module.variable('power')).toBe('on')
				})

				// Well into the wait between two passes, every inquiry sent
				// has been answered.
				await timePasses(PollInterval / 2)
				const receivedBefore = camera.received.length

				// The camera has the command, and hasn't acknowledged it,
				// when it sends the answer.
				camera.hold()
				await module.executeAction(PowerActionId.CameraPowerState, { bool: 'off' })
				await eventually(() => {
					expect(camera.received.length).toBeGreaterThan(receivedBefore)
				})
				expect(camera.received.slice(receivedBefore)).toEqual([PowerStandbyBytes])
				camera.send(StrayAnswer)
				await eventually(() => {
					expect(errorsLogged(module)).toEqual([])
					expect(module.logs).toContainEqual({
						level: 'debug',
						message: 'Ignoring unsolicited inquiry response [90 50 03 FF]',
					})
				})
				expect(module.variable('power')).toBe('on')
				camera.release()

				await eventually(() => {
					expect(camera.power).toBe('standby')
					expect(module.variable('power')).toBe('standby')
				})

				// And values go on following the camera.
				await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
				await eventually(() => {
					expect(camera.power).toBe('on')
					expect(module.variable('power')).toBe('on')
				})
				expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])
				expect(errorsLogged(module)).toEqual([])
			} finally {
				await module.destroy()
				await camera.stop()
			}
		})
	},
)
