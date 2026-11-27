import { InstanceStatus } from '@companion-module/base'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import { eventually } from './faked-time.js'
import { ModuleUnderTest } from './module-under-test.js'
import { CameraPowerBytes } from '../visca/__tests__/camera-interactions/bytes.js'
import { Cameras, PowerInquiryBytes } from '../visca/__tests__/simulator/cameras.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'

/** How many poll passes the module must get through with the camera in standby. */
const StandbyPollPasses = 10

describe.each(Cameras)('camera in standby when the module connects: $name', ({ replies }) => {
	// Fake only the timers, not the sockets, so that the waits between poll
	// passes take no real time.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	test('connection stays ok, only power is polled, and Power On reaches the camera', async () => {
		const camera = await SimulatedCamera.start({ power: 'standby', replies })

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: true,
			pollInterval: 100,
		})
		try {
			await eventually(() => {
				expect(module.variable('power')).toBe('standby')
			})

			// Let polling run for a while -- or stop early if the connection
			// failed, so that the failure is what's reported.
			await eventually(() => {
				if (!module.statuses.includes(InstanceStatus.ConnectionFailure)) {
					expect(camera.received.length).toBeGreaterThanOrEqual(StandbyPollPasses)
				}
			})

			expect(module.statuses).not.toContain(InstanceStatus.ConnectionFailure)
			expect(module.status).toBe(InstanceStatus.Ok)
			expect(module.variable('power')).toBe('standby')

			// A camera in standby may refuse every inquiry but power, so
			// nothing else should have been asked of it.
			for (const message of camera.received) {
				expect(message).toEqual(PowerInquiryBytes)
			}

			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
			await eventually(() => {
				expect(camera.power).toBe('on')
			})
			expect(camera.received).toContainEqual(CameraPowerBytes)
			expect(module.status).toBe(InstanceStatus.Ok)
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})
})
