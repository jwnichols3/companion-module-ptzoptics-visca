import { InstanceStatus } from '@companion-module/base'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import { ModuleUnderTest } from './module-under-test.js'
import { CameraPowerBytes } from '../visca/__tests__/camera-interactions/bytes.js'
import { RecordedReplies } from '../visca/__tests__/simulator/recorded-replies.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'

/** How long the module's socket waits after a failed attempt to connect before trying again. */
const ReconnectInterval = 2000

describe('camera unreachable when the module starts, then appears', () => {
	// Fake only the timers, not the sockets, so that waiting out a reconnect
	// interval takes no real time.  `vi.waitFor` advances the fake timers a
	// little every time it checks.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	test('connecting while unreachable, ok within a reconnect interval, and Power On reaches the camera', async () => {
		const camera = await SimulatedCamera.start({ power: 'standby', replies: RecordedReplies })
		camera.refuseConnections()

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: true,
			pollInterval: 100,
		})
		try {
			await vi.waitFor(() => {
				expect(module.logs).toContainEqual({
					level: 'error',
					message: expect.stringMatching(/^Network error: connect ECONNREFUSED/),
				})
			})

			// The module keeps trying to make its first connection, so that
			// Companion and the camera can be started in either order.
			expect(module.status).toBe(InstanceStatus.Connecting)
			expect(module.statuses).not.toContain(InstanceStatus.Ok)

			await camera.acceptConnections()

			// One reconnect interval is enough for the next attempt to be
			// made; the wait that follows only lets that attempt complete.
			vi.advanceTimersByTime(ReconnectInterval)
			await vi.waitFor(() => {
				expect(module.status).toBe(InstanceStatus.Ok)
			})

			await vi.waitFor(() => {
				expect(module.variable('power')).toBe('standby')
			})

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
