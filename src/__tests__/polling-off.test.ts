import { InstanceStatus } from '@companion-module/base'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import { describeEachCamera } from './each-camera.js'
import { eventually, timePasses } from './faked-time.js'
import { ModuleUnderTest } from './module-under-test.js'
import { CameraPowerBytes } from '../visca/__tests__/camera-interactions/bytes.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'

const CameraStandbyBytes = [0x81, 0x01, 0x04, 0x00, 0x03, 0xff]

/** Long enough for the module to send an inquiry of its own, if it were ever going to. */
const Minute = 60 * 1000

function errorsLogged(module: ModuleUnderTest): string[] {
	return module.logs.filter(({ level }) => level === 'error').map(({ message }) => message)
}

describeEachCamera('status polling off', ['on', 'standby'], ({ replies }) => {
	// Fake only the timers, not the sockets, so that minutes of nothing
	// happening, and a wake-up played back as slowly as it was recorded, take
	// no real time.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	/** How long after it's told to power on the camera does the last thing it does as it wakes. */
	const wakeUpTakes = replies.wakeUp?.at(-1)?.atMs ?? 0

	test('no inquiry is ever sent: not once connected, across Power Off and Power On, or after reconnecting', async () => {
		const camera = await SimulatedCamera.start({ power: 'on', replies })

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: false,
		})
		try {
			await eventually(() => {
				expect(module.status).toBe(InstanceStatus.Ok)
			})
			await timePasses(Minute)

			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'off' })
			await eventually(() => {
				expect(camera.power).toBe('standby')
			})
			await timePasses(Minute)

			// However the camera wakes, the module asks nothing of it, so
			// can't find it silent: the connection is left alone.
			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
			await eventually(() => {
				expect(camera.power).toBe('on')
			})
			await timePasses(wakeUpTakes + Minute)
			expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])
			expect(errorsLogged(module)).toEqual([])

			// The camera drops off the network and comes back.
			camera.refuseConnections()
			camera.dropConnection()
			await eventually(() => {
				expect(module.logs).toContainEqual({
					level: 'error',
					message: expect.stringMatching(/^Network error: connect ECONNREFUSED/),
				})
			})
			await camera.acceptConnections()
			await eventually(() => {
				expect(module.status).toBe(InstanceStatus.Ok)
			})
			await timePasses(Minute)

			// Commands still reach the camera, and they are all it was sent.
			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'off' })
			await eventually(() => {
				expect(camera.power).toBe('standby')
			})
			expect(camera.received).toEqual([CameraStandbyBytes, CameraPowerBytes, CameraStandbyBytes])
			expect(module.status).toBe(InstanceStatus.Ok)
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})
})
