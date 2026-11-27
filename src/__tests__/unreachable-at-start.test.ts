import { InstanceStatus } from '@companion-module/base'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import { eventually } from './faked-time.js'
import { ModuleUnderTest } from './module-under-test.js'
import { CameraPowerBytes } from '../visca/__tests__/camera-interactions/bytes.js'
import { Cameras } from '../visca/__tests__/simulator/cameras.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'

/** How long the module's socket waits after a failed attempt to connect before trying again. */
const ReconnectInterval = 2000

describe.each(Cameras)(
	'camera unreachable when the module starts, then appears: $name',
	({ replies: { on, standby } }) => {
		// How a camera wakes is for other scenarios: this one is on as soon as
		// it's told to be.
		const replies = { on, standby }

		// Fake only the timers, not the sockets, so that waiting out a reconnect
		// interval takes no real time.  `eventually` lets faked time go by
		// while it waits.
		beforeEach(() => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		})
		afterEach(() => {
			vi.useRealTimers()
		})

		test('status is Connecting, never a failure, for as long as the camera has never been reached; ok within a reconnect interval of its appearing; and Power On reaches the camera', async () => {
			const camera = await SimulatedCamera.start({ power: 'standby', replies })
			camera.refuseConnections()

			const module = await ModuleUnderTest.start({
				host: '127.0.0.1',
				port: String(camera.port),
				pollEnabled: true,
				pollInterval: 100,
			})
			try {
				await eventually(() => {
					expect(module.logs).toContainEqual({
						level: 'error',
						message: expect.stringMatching(/^Network error: connect ECONNREFUSED/),
					})
				})

				// This is the port's behavior as it came from upstream, not
				// something this scenario would choose: until the port has
				// made its first connection, a failed attempt to connect
				// changes nothing, so that Companion and the camera can be
				// started in either order.  The status therefore stays
				// Connecting, and is never Connection Failure, however long
				// a camera that has never been reached stays unreachable.
				// (A camera lost after it was reached does show as a failure:
				// see `connection-dropped.test.ts`.)
				vi.advanceTimersByTime(ReconnectInterval)
				await eventually(() => {
					expect(
						module.logs.filter(({ message }) => /^Network error: connect ECONNREFUSED/.test(message)).length,
					).toBeGreaterThan(1)
				})
				expect(module.statuses).toEqual([InstanceStatus.Connecting])

				await camera.acceptConnections()

				// One reconnect interval is enough for the next attempt to be
				// made; the wait that follows only lets that attempt complete.
				vi.advanceTimersByTime(ReconnectInterval)
				await eventually(() => {
					expect(module.status).toBe(InstanceStatus.Ok)
				})

				await eventually(() => {
					expect(module.variable('power')).toBe('standby')
				})

				await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
				await eventually(() => {
					expect(camera.received).toContainEqual(CameraPowerBytes)
				})
				expect(camera.power).toBe('on')
				await eventually(() => {
					expect(module.variable('power')).toBe('on')
				})
				expect(module.status).toBe(InstanceStatus.Ok)
			} finally {
				await module.destroy()
				await camera.stop()
			}
		})
	},
)
