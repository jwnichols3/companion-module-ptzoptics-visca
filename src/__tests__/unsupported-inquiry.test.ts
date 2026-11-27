import { InstanceStatus } from '@companion-module/base'
import { describe, expect, test, vi } from 'vitest'
import { ModuleUnderTest } from './module-under-test.js'
import { HandWrittenCamera, PowerInquiryBytes } from '../visca/__tests__/simulator/cameras.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'
import type { Bytes } from '../utils/byte.js'

const ExposureModeInquiryBytes = [0x81, 0x09, 0x04, 0x39, 0xff]

function timesReceived(camera: SimulatedCamera, message: Bytes): number {
	return camera.received.filter((received) => String(received) === String(message)).length
}

describe('camera lacks an inquiry', () => {
	test('powered on: the inquiry is refused on three passes, then is no longer sent', async () => {
		// The camera answers the exposure inquiries with a syntax error.
		const camera = await SimulatedCamera.start({ power: 'on', replies: HandWrittenCamera.replies })

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: true,
			pollInterval: 10,
			pollGroups: ['power', 'exposure'],
		})
		try {
			await vi.waitFor(() => {
				expect(timesReceived(camera, PowerInquiryBytes)).toBeGreaterThan(6)
			})

			expect(timesReceived(camera, ExposureModeInquiryBytes)).toBe(3)
			expect(module.logs).toContainEqual({
				level: 'info',
				message: 'Camera didn\'t answer the "exposure-mode" status inquiry; no longer polling it',
			})
			expect(module.variable('power')).toBe('on')
			expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})
})
