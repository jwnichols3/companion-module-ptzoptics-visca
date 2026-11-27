import { InstanceStatus } from '@companion-module/base'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { eventually, timePasses } from './faked-time.js'
import { ModuleUnderTest } from './module-under-test.js'
import { HandWrittenCamera, PowerInquiryBytes } from '../visca/__tests__/simulator/cameras.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'
import type { Bytes } from '../utils/byte.js'

const ExposureModeInquiryBytes = [0x81, 0x09, 0x04, 0x39, 0xff]

/** Nearly as long as the module takes a camera that says it's on to be still waking. */
const StillWaking = 9000

/** Long enough afterward for the module to have given up on an inquiry the camera refuses. */
const LongAfter = 10_000

function timesReceived(camera: SimulatedCamera, message: Bytes): number {
	return camera.received.filter((received) => String(received) === String(message)).length
}

function noLongerPolled(module: ModuleUnderTest): string[] {
	return module.logs.map(({ message }) => message).filter((message) => message.includes('no longer polling'))
}

describe('camera lacks an inquiry', () => {
	// Fake only the timers, not the sockets, so that waiting for the camera
	// to be taken as awake takes no real time.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	test('powered on: the inquiry is refused throughout the time the camera is taken to be waking and on three passes more, then is no longer sent', async () => {
		// The camera answers the exposure inquiries with a syntax error.
		const camera = await SimulatedCamera.start({ power: 'on', replies: HandWrittenCamera.replies })

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: true,
			pollInterval: 500,
			pollGroups: ['power', 'exposure'],
		})
		try {
			// A camera that has only just been seen on may yet answer what it
			// refuses, so no refusal counts against the inquiry.
			await timePasses(StillWaking)
			expect(timesReceived(camera, ExposureModeInquiryBytes)).toBeGreaterThan(10)
			expect(noLongerPolled(module)).toEqual([])

			await eventually(() => {
				expect(module.logs).toContainEqual({
					level: 'info',
					message: 'Camera didn\'t answer the "exposure-mode" status inquiry; no longer polling it',
				})
			}, LongAfter)

			const refused = timesReceived(camera, ExposureModeInquiryBytes)
			const passesBefore = timesReceived(camera, PowerInquiryBytes)
			await timePasses(LongAfter)
			expect(timesReceived(camera, PowerInquiryBytes)).toBeGreaterThan(passesBefore + 10)
			expect(timesReceived(camera, ExposureModeInquiryBytes)).toBe(refused)

			expect(module.variable('power')).toBe('on')
			expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})
})
