import { InstanceStatus } from '@companion-module/base'
import { describe, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import { ModuleUnderTest } from './module-under-test.js'
import { CameraPowerBytes } from '../visca/__tests__/camera-interactions/bytes.js'
import { PowerInquiryBytes, RecordedReplies } from '../visca/__tests__/simulator/recorded-replies.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'

/** How many poll passes the module must get through with the camera in standby. */
const StandbyPollPasses = 10

describe('camera in standby when the module connects', () => {
	test('connection stays ok, only power is polled, and Power On reaches the camera', async () => {
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

			// Let polling run for a while -- or stop early if the connection
			// failed, so that the failure is what's reported.
			await vi.waitFor(
				() => {
					if (!module.statuses.includes(InstanceStatus.ConnectionFailure)) {
						expect(camera.received.length).toBeGreaterThanOrEqual(StandbyPollPasses)
					}
				},
				{ timeout: 5000 },
			)

			expect(module.statuses).not.toContain(InstanceStatus.ConnectionFailure)
			expect(module.status).toBe(InstanceStatus.Ok)
			expect(module.variable('power')).toBe('standby')

			// A camera in standby refuses every inquiry but power, so nothing
			// else should have been asked of it.
			for (const message of camera.received) {
				expect(message).toEqual(PowerInquiryBytes)
			}

			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
			await vi.waitFor(() => {
				expect(camera.received).toContainEqual(CameraPowerBytes)
			})
			expect(camera.power).toBe('on')
			expect(module.status).toBe(InstanceStatus.Ok)
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})
})
