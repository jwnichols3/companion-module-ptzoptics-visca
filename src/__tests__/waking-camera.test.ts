import { InstanceStatus, type LogLevel } from '@companion-module/base'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import { eventually } from './faked-time.js'
import { ModuleUnderTest } from './module-under-test.js'
import { CameraPowerBytes } from '../visca/__tests__/camera-interactions/bytes.js'
import { Cameras } from '../visca/__tests__/simulator/cameras.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'

const CameraStandbyBytes = [0x81, 0x01, 0x04, 0x00, 0x03, 0xff]

/** How many inquiries a poll pass of the power, position and lens groups sends. */
const InquiriesPerPass = 5

/**
 * Longer than the module needs to find that a camera it had found silent as
 * it woke is answering again: a wait for an answer, then a new connection.
 */
const Recovery = 10_000

function logged(module: ModuleUnderTest, ...levels: LogLevel[]): string[] {
	return module.logs.filter(({ level }) => levels.includes(level)).map(({ message }) => message)
}

function saidWaking(module: ModuleUnderTest): string[] {
	return logged(module, 'info').filter((message) => message.startsWith('Camera is waking'))
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

	test('status is connecting while the camera is silent and never failed, one line says it is waking, values update again, and a command reaches the camera', async () => {
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
			// send answers nothing asked for.  That's expected of a camera
			// just told to power on, so the connection is shown as being
			// made, not as failed, until the camera answers.
			await eventually(() => {
				expect(module.status).toBe(InstanceStatus.Connecting)
			})
			await eventually(() => {
				expect(module.variable('power')).toBe('on')
			}, wakeUpTakes + Recovery)
			await eventually(() => {
				expect(typeof module.variable('zoom')).toBe('number')
				expect(typeof module.variable('focus_mode')).toBe('string')
			})

			// The wake-up cost no inquiry: every one is asked again, pass
			// after pass, and the connection stays ok.
			const receivedAwake = camera.received.length
			await eventually(() => {
				expect(camera.received.length).toBeGreaterThanOrEqual(receivedAwake + 10 * InquiriesPerPass)
			})
			expect(new Set(camera.received.slice(receivedAwake).map(String)).size).toBe(InquiriesPerPass)
			expect(module.logs.filter(({ message }) => message.includes('no longer polling'))).toEqual([])

			expect(module.statuses).toEqual([
				InstanceStatus.Connecting,
				InstanceStatus.Ok,
				InstanceStatus.Connecting,
				InstanceStatus.Ok,
			])
			expect(saidWaking(module)).toHaveLength(1)
			expect(logged(module, 'warn', 'error')).toEqual([])

			// The camera has woken, so a connection lost now has failed.
			camera.dropConnection()
			await eventually(() => {
				expect(module.statuses.slice(4)).toEqual([
					InstanceStatus.ConnectionFailure,
					InstanceStatus.Connecting,
					InstanceStatus.Ok,
				])
			})

			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'off' })
			await eventually(() => {
				expect(module.variable('power')).toBe('standby')
			})
			expect(camera.received).toContainEqual(CameraStandbyBytes)
			expect(module.statuses).toHaveLength(7)
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})
})
