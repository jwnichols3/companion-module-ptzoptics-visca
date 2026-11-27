import { InstanceStatus } from '@companion-module/base'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import { describeEachCamera } from './each-camera.js'
import { eventually } from './faked-time.js'
import { ModuleUnderTest } from './module-under-test.js'
import { CameraPowerBytes } from '../visca/__tests__/camera-interactions/bytes.js'
import { PowerInquiryBytes } from '../visca/__tests__/simulator/cameras.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'

const CameraStandbyBytes = [0x81, 0x01, 0x04, 0x00, 0x03, 0xff]

/** How many inquiries a poll pass of the power, position and lens groups sends. */
const InquiriesPerPass = 5

/** How many times faster than recorded the camera wakes up. */
const WakeUpSpeed = 20

/**
 * Longer than the module needs to find that a camera it had found silent as
 * it woke is answering again: a wait for an answer, then a new connection.
 */
const Recovery = 10_000

describeEachCamera('camera on, sent to standby, then powered on', ['on', 'standby'], ({ replies }) => {
	// Fake only the timers, not the sockets, so that neither the waits between
	// poll passes nor the wake-up take real time.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	// A camera may stop answering, or drop the connection, as it wakes.  That's
	// expected of a camera just told to power on, so the connection is shown
	// as being made, not as failed, until the camera answers.  If the camera
	// does neither, the connection must stay ok throughout.
	const wakeUp = replies.wakeUp ?? []
	const unreachableWaking = wakeUp.some(({ does }) => does === 'goes-silent' || does === 'drops-connection')

	test('connection is never failed, is connecting only while the camera stops answering as it wakes, and values update again', async () => {
		const camera = await SimulatedCamera.start({ power: 'on', replies, wakeUpSpeed: WakeUpSpeed })

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: true,
			pollInterval: 100,
			pollGroups: ['power', 'position', 'lens'],
		})
		try {
			await eventually(() => {
				expect(module.variable('power')).toBe('on')
			})
			await eventually(() => {
				expect(typeof module.variable('zoom')).toBe('number')
			})

			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'off' })
			await eventually(() => {
				expect(module.variable('power')).toBe('standby')
			})
			expect(camera.received).toContainEqual(CameraStandbyBytes)

			// In standby, only power is asked after.
			const receivedInStandby = camera.received.length
			await eventually(() => {
				expect(camera.received.length).toBeGreaterThanOrEqual(receivedInStandby + 10)
			})
			for (const message of camera.received.slice(receivedInStandby)) {
				expect(message).toEqual(PowerInquiryBytes)
			}
			expect(module.variable('power')).toBe('standby')
			expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])

			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
			await eventually(() => {
				expect(camera.power).toBe('on')
			})
			expect(camera.received).toContainEqual(CameraPowerBytes)

			const wakeUpTakes = (wakeUp.at(-1)?.atMs ?? 0) / WakeUpSpeed
			await eventually(() => {
				expect(module.variable('power')).toBe('on')
			}, wakeUpTakes + Recovery)

			// Every inquiry is asked again, pass after pass, and none was
			// taken for unsupported because of the wake-up.
			const receivedAwake = camera.received.length
			await eventually(() => {
				expect(camera.received.length).toBeGreaterThanOrEqual(receivedAwake + 10 * InquiriesPerPass)
			})
			expect(new Set(camera.received.slice(receivedAwake).map(String)).size).toBe(InquiriesPerPass)
			expect(module.logs.filter(({ message }) => message.includes('no longer polling'))).toEqual([])
			expect(typeof module.variable('zoom')).toBe('number')

			const statusesSincePowerOn = module.statuses.slice(2)
			const saidWaking = module.logs.filter(({ message }) => message.startsWith('Camera is waking'))
			if (unreachableWaking) {
				expect(statusesSincePowerOn).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])
				expect(saidWaking).toHaveLength(1)
			} else {
				expect(statusesSincePowerOn).toEqual([])
				expect(saidWaking).toEqual([])
			}
			expect(module.logs.filter(({ level }) => level === 'warn' || level === 'error')).toEqual([])
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})
})
