import { InstanceStatus } from '@companion-module/base'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import { eventually, timePasses } from './faked-time.js'
import { ModuleUnderTest } from './module-under-test.js'
import { CameraPowerBytes } from '../visca/__tests__/camera-interactions/bytes.js'
import { Cameras } from '../visca/__tests__/simulator/cameras.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'

const CameraStandbyBytes = [0x81, 0x01, 0x04, 0x00, 0x03, 0xff]

/** How many inquiries a poll pass of the power, position and lens groups sends. */
const InquiriesPerPass = 5

/**
 * Longer than the module needs to notice that a camera that stopped answering
 * as it woke is answering again: a wait for an answer, then a new connection.
 */
const Recovery = 10_000

function errorsLogged(module: ModuleUnderTest): string[] {
	return module.logs.filter(({ level }) => level === 'error').map(({ message }) => message)
}

/** The cameras whose wake-up was recorded. */
const CamerasRecordedWaking = Cameras.flatMap(({ name, replies }) =>
	replies.wakeUp === undefined ? [] : [{ name, replies, wakeUp: replies.wakeUp }],
)

describe.each(CamerasRecordedWaking)('camera wakes from standby: $name', ({ replies, wakeUp }) => {
	// Fake only the timers, not the sockets, so that a wake-up of half a
	// minute, played back as slowly as it was recorded, takes no real time.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	/** How long after it's told to power on the camera does the last thing it does as it wakes. */
	const wakeUpTakes = wakeUp.at(-1)?.atMs ?? 0

	test('status returns to ok without user action, nothing is taken for unsupported, values update again, and a command reaches the camera', async () => {
		const camera = await SimulatedCamera.start({ power: 'standby', replies })

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: true,
			pollInterval: 100,
			pollGroups: ['power', 'position', 'lens'],
		})
		try {
			await eventually(() => {
				expect(module.variable('power')).toBe('standby')
			})
			expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])

			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
			await eventually(() => {
				expect(camera.power).toBe('on')
			})
			expect(camera.received).toContainEqual(CameraPowerBytes)

			// A waking camera may stop answering, refuse connections, and
			// send answers nothing asked for.  The module can't tell a camera
			// that has stopped answering from one that's gone, so the
			// connection may be lost meanwhile.  It must be ok again, and
			// values must update again, with no help from the user.
			await eventually(() => {
				expect(module.variable('power')).toBe('on')
			}, wakeUpTakes + Recovery)
			await eventually(() => {
				expect(typeof module.variable('zoom')).toBe('number')
				expect(typeof module.variable('focus_mode')).toBe('string')
			})
			expect(module.status).toBe(InstanceStatus.Ok)
			expect(module.statuses).not.toContain(InstanceStatus.UnknownError)
			expect(module.statuses).not.toContain(InstanceStatus.Disconnected)

			// The wake-up cost no inquiry: every one is asked again, pass
			// after pass, and the connection stays ok.
			const receivedAwake = camera.received.length
			await eventually(() => {
				expect(camera.received.length).toBeGreaterThanOrEqual(receivedAwake + 10 * InquiriesPerPass)
			})
			expect(new Set(camera.received.slice(receivedAwake).map(String)).size).toBe(InquiriesPerPass)
			expect(module.logs.filter(({ message }) => message.includes('no longer polling'))).toEqual([])
			expect(module.status).toBe(InstanceStatus.Ok)
			expect(errorsLogged(module)).toEqual(
				errorsLogged(module).filter((message) => /^Network error: connect ECONNREFUSED/.test(message)),
			)

			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'off' })
			await eventually(() => {
				expect(module.variable('power')).toBe('standby')
			})
			expect(camera.received).toContainEqual(CameraStandbyBytes)
			expect(module.status).toBe(InstanceStatus.Ok)
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})

	test('polling off: nothing is asked of the waking camera, and the connection is left alone', async () => {
		const camera = await SimulatedCamera.start({ power: 'standby', replies })

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: false,
		})
		try {
			await eventually(() => {
				expect(module.status).toBe(InstanceStatus.Ok)
			})

			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
			await eventually(() => {
				expect(camera.power).toBe('on')
			})

			await timePasses(wakeUpTakes + Recovery)
			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
			await eventually(() => {
				expect(camera.received.length).toBeGreaterThanOrEqual(2)
			})
			expect(camera.received).toEqual([CameraPowerBytes, CameraPowerBytes])
			expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])
			expect(errorsLogged(module)).toEqual([])
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})
})
