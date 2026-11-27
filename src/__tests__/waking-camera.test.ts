import { InstanceStatus } from '@companion-module/base'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import { ModuleUnderTest } from './module-under-test.js'
import { CameraPowerBytes } from '../visca/__tests__/camera-interactions/bytes.js'
import { PowerInquiryBytes, RecordedReplies } from '../visca/__tests__/simulator/recorded-replies.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'

/** How long the module's socket waits after a failed attempt to connect before trying again. */
const ReconnectInterval = 2000

/** How long the module gives the camera to answer a polled inquiry. */
const InquiryTimeout = 3000

const CameraStandbyBytes = [0x81, 0x01, 0x04, 0x00, 0x03, 0xff]

/** The camera's answer to the power inquiry when it's on. */
const PowerOnAnswer = [0x90, 0x50, 0x02, 0xff]

function errorsLogged(module: ModuleUnderTest): string[] {
	return module.logs.filter(({ level }) => level === 'error').map(({ message }) => message)
}

/**
 * Wait for the camera to receive a power inquiry after its first `after`
 * messages, then for the module to give up on the answer.
 *
 * @returns
 *    How many messages the camera had received when the module gave up.
 */
async function powerInquiryGoesUnanswered(camera: SimulatedCamera, after: number): Promise<number> {
	await vi.waitFor(() => {
		expect(camera.received.slice(after)).toContainEqual(PowerInquiryBytes)
	})
	const received = camera.received.length
	vi.advanceTimersByTime(InquiryTimeout)
	return received
}

describe('camera wakes from standby', () => {
	// Fake only the timers, not the sockets, so that a wake-up of half a
	// minute takes no real time.  `vi.waitFor` advances the fake timers a
	// little every time it checks.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	// The wake-up recorded from a PTZOptics camera (2026-11-27), with the
	// waits shortened.  Times are from when Power On was sent:
	//
	//    0 s  Power On is acknowledged and completed.  Inquiries go
	//         unanswered, and the connection is never closed.
	//    2 s  A new connection is accepted, and is as silent.
	//    4 s  New connections aren't accepted.
	//   14 s  New connections are accepted again, and are still silent.
	//   29 s  The power inquiry is answered, on a new connection, followed by
	//         a second power answer that nothing asked for.
	//   31 s  Every inquiry is answered.
	test('status returns to ok without user action, values update again, and a command reaches the camera', async () => {
		const camera = await SimulatedCamera.start({ power: 'standby', replies: RecordedReplies })

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: true,
			pollInterval: 100,
			pollGroups: ['power', 'position', 'lens'],
		})
		try {
			await vi.waitFor(() => {
				expect(module.variable('power')).toBe('standby')
			})

			camera.goSilentOnPowerOn()
			let received = camera.received.length
			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
			await vi.waitFor(() => {
				expect(camera.power).toBe('on')
			})

			// Silent on the first connection: the module takes it for lost
			// and makes a new one, which the camera accepts.
			received = await powerInquiryGoesUnanswered(camera, received)
			await vi.waitFor(() => {
				expect(module.statuses).toEqual([
					InstanceStatus.Connecting,
					InstanceStatus.Ok,
					InstanceStatus.ConnectionFailure,
					InstanceStatus.Connecting,
					InstanceStatus.Ok,
				])
			})

			// Silent on the new connection too, and then the camera stops
			// accepting connections.
			camera.refuseConnections()
			received = await powerInquiryGoesUnanswered(camera, received)
			await vi.waitFor(() => {
				expect(module.logs).toContainEqual({
					level: 'error',
					message: expect.stringMatching(/^Network error: connect ECONNREFUSED/),
				})
			})
			expect(module.status).toBe(InstanceStatus.Connecting)

			// Connections are accepted again, and are still silent.
			await camera.acceptConnections()
			vi.advanceTimersByTime(ReconnectInterval)
			await vi.waitFor(() => {
				expect(module.status).toBe(InstanceStatus.Ok)
			})
			received = await powerInquiryGoesUnanswered(camera, received)
			await vi.waitFor(() => {
				expect(module.status).toBe(InstanceStatus.Ok)
			})
			expect(module.variable('power')).toBe('standby')

			// The camera answers again, but not what it was asked while
			// silent.  Its first answer comes with a power answer that nothing
			// asked for.
			await vi.waitFor(() => {
				expect(camera.received.slice(received)).toContainEqual(PowerInquiryBytes)
			})
			camera.answerAgain()
			camera.replyGarbled([...PowerOnAnswer, ...PowerOnAnswer])
			vi.advanceTimersByTime(InquiryTimeout)

			// Values update again, with no help from the user.
			await vi.waitFor(() => {
				expect(module.variable('power')).toBe('on')
				expect(module.variable('zoom')).toBe(0x28f7)
				expect(module.variable('focus_mode')).toBe('auto')
			})
			expect(module.status).toBe(InstanceStatus.Ok)

			// The unsolicited answer didn't cost the connection, nor did the
			// wake-up cost any inquiry.
			const receivedAwake = camera.received.length
			await vi.waitFor(() => {
				expect(camera.received.length).toBeGreaterThan(receivedAwake + 10)
			})
			expect(module.status).toBe(InstanceStatus.Ok)
			expect(new Set(camera.received.slice(receivedAwake).map(String)).size).toBe(5)
			expect(errorsLogged(module)).toEqual(
				errorsLogged(module).filter((message) => /^Network error: connect ECONNREFUSED/.test(message)),
			)

			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'off' })
			await vi.waitFor(() => {
				expect(camera.received).toContainEqual(CameraStandbyBytes)
			})
			expect(camera.received).toContainEqual(CameraPowerBytes)
			await vi.waitFor(() => {
				expect(module.variable('power')).toBe('standby')
			})
			expect(module.status).toBe(InstanceStatus.Ok)
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})

	test('polling off: nothing is asked of the silent camera, and the connection is left alone', async () => {
		const camera = await SimulatedCamera.start({ power: 'standby', replies: RecordedReplies })

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: false,
		})
		try {
			await vi.waitFor(() => {
				expect(module.status).toBe(InstanceStatus.Ok)
			})

			camera.goSilentOnPowerOn()
			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
			await vi.waitFor(() => {
				expect(camera.power).toBe('on')
			})

			vi.advanceTimersByTime(10 * InquiryTimeout)
			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
			await vi.waitFor(() => {
				expect(camera.received).toEqual([CameraPowerBytes, CameraPowerBytes])
			})
			expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])
			expect(errorsLogged(module)).toEqual([])
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})
})
