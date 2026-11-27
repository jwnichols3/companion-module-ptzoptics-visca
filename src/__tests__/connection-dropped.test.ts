import { InstanceStatus } from '@companion-module/base'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import { ModuleUnderTest } from './module-under-test.js'
import { CameraPowerBytes } from '../visca/__tests__/camera-interactions/bytes.js'
import { PowerInquiryBytes, RecordedReplies } from '../visca/__tests__/simulator/recorded-replies.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'

/** How long the module's socket waits after a failed attempt to connect before trying again. */
const ReconnectInterval = 2000

/** Longer than the module is given to do anything in this test. */
const Never = 60 * 60 * 1000

describe('connection dropped in the middle of a poll, then the camera comes back', () => {
	// Fake only the timers, not the sockets, so that waiting out a reconnect
	// interval takes no real time.  `vi.waitFor` advances the fake timers a
	// little every time it checks.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	test('connection fails, recovers without user action, polling resumes, and Power On reaches the camera', async () => {
		const camera = await SimulatedCamera.start({ power: 'standby', replies: RecordedReplies })

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: true,
			pollInterval: 100,
		})
		try {
			await vi.waitFor(() => {
				expect(module.variable('power')).toBe('standby')
			})
			expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])

			// Leave the module waiting on the answer to an inquiry, then take
			// the camera off the network.
			const receivedBefore = camera.received.length
			camera.replyLate(Never)
			await vi.waitFor(() => {
				expect(camera.received.length).toBeGreaterThan(receivedBefore)
			})
			expect(camera.received.at(-1)).toEqual(PowerInquiryBytes)
			camera.refuseConnections()
			camera.dropConnection()

			await vi.waitFor(() => {
				expect(module.logs).toContainEqual({
					level: 'error',
					message: expect.stringMatching(/^Network error: connect ECONNREFUSED/),
				})
			})
			expect(module.statuses).toEqual([
				InstanceStatus.Connecting,
				InstanceStatus.Ok,
				InstanceStatus.ConnectionFailure,
				InstanceStatus.Connecting,
			])

			await camera.acceptConnections()

			// One reconnect interval is enough for the next attempt to be
			// made; the wait that follows only lets that attempt complete.
			vi.advanceTimersByTime(ReconnectInterval)
			await vi.waitFor(() => {
				expect(module.status).toBe(InstanceStatus.Ok)
			})

			// Polling resumed if the module notices the camera powering on.
			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
			await vi.waitFor(() => {
				expect(camera.received).toContainEqual(CameraPowerBytes)
			})
			expect(camera.power).toBe('on')
			await vi.waitFor(() => {
				expect(module.variable('power')).toBe('on')
			})
			expect(module.status).toBe(InstanceStatus.Ok)
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})
})
