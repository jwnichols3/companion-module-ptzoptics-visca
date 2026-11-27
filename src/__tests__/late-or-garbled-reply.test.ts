import { InstanceStatus } from '@companion-module/base'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import { describeEachCamera } from './each-camera.js'
import { eventually } from './faked-time.js'
import { ModuleUnderTest } from './module-under-test.js'
import { CameraPowerBytes } from '../visca/__tests__/camera-interactions/bytes.js'
import { PowerInquiryBytes } from '../visca/__tests__/simulator/cameras.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'

/** How long the module's socket waits after a failed attempt to connect before trying again. */
const ReconnectInterval = 2000

/** How long the module gives the camera to answer a polled inquiry. */
const InquiryTimeout = 3000

/** How late a late reply is: several poll intervals. */
const Late = 1000

function errorsLogged(module: ModuleUnderTest): string[] {
	return module.logs.filter(({ level }) => level === 'error').map(({ message }) => message)
}

describeEachCamera(
	'a reply from the camera arrives late or garbled',
	['on', 'standby'],
	({ replies: { on, standby } }) => {
		// How a camera wakes is for other scenarios: this one is on as soon as
		// it's told to be.
		const replies = { on, standby }

		// Fake only the timers, not the sockets, so that lateness takes no real
		// time.  `eventually` lets faked time go by while it waits.
		beforeEach(() => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		})
		afterEach(() => {
			vi.useRealTimers()
		})

		// The port sets no time limit on a reply, so a reply that's only a little
		// late fails nothing: it answers its inquiry when it arrives.

		test('one reply late: a Power On sent meanwhile reaches the camera, and nothing fails', async () => {
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

				const receivedBefore = camera.received.length
				camera.replyLate(Late)
				await eventually(() => {
					expect(camera.received.length).toBeGreaterThan(receivedBefore)
				})

				// The command waits only briefly behind the unanswered inquiry.
				await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
				await eventually(() => {
					expect(camera.power).toBe('on')
				})
				expect(camera.received.slice(receivedBefore)).toEqual([PowerInquiryBytes, CameraPowerBytes])

				// Once the late reply is in, polling carries on.
				vi.advanceTimersByTime(Late)
				await eventually(() => {
					expect(module.variable('power')).toBe('on')
				})

				expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])
				expect(errorsLogged(module)).toEqual([])
			} finally {
				await module.destroy()
				await camera.stop()
			}
		})

		test('camera stalls: a Power On sent meanwhile is acted on afterward, and nothing fails', async () => {
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

				const receivedBefore = camera.received.length
				camera.stall(Late)
				await eventually(() => {
					expect(camera.received.length).toBeGreaterThan(receivedBefore)
				})

				await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
				await eventually(() => {
					expect(camera.received.slice(receivedBefore)).toEqual([PowerInquiryBytes, CameraPowerBytes])
				})
				expect(camera.power).toBe('standby')

				vi.advanceTimersByTime(Late)
				await eventually(() => {
					expect(module.variable('power')).toBe('on')
				})
				expect(camera.power).toBe('on')

				expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])
				expect(errorsLogged(module)).toEqual([])
			} finally {
				await module.destroy()
				await camera.stop()
			}
		})

		// The status poller does set a time limit on the answers to its own
		// inquiries.  A reply later than that finds its connection replaced.

		test('one reply later than the time limit: the module reconnects, and the reply is never taken for an answer', async () => {
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

				const receivedBefore = camera.received.length
				camera.replyLate(2 * InquiryTimeout)
				await eventually(() => {
					expect(camera.received.length).toBeGreaterThan(receivedBefore)
				})

				vi.advanceTimersByTime(InquiryTimeout)
				await eventually(() => {
					expect(module.status).toBe(InstanceStatus.Ok)
					expect(camera.received.length).toBeGreaterThan(receivedBefore + 1)
				})

				// The camera has powered on by the time the late reply, which
				// says standby, is sent.
				await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
				await eventually(() => {
					expect(module.variable('power')).toBe('on')
				})
				const receivedOn = camera.received.length
				vi.advanceTimersByTime(InquiryTimeout)
				await eventually(() => {
					expect(camera.received.length).toBeGreaterThan(receivedOn + 3)
				})
				expect(module.variable('power')).toBe('on')

				expect(module.statuses).toEqual([
					InstanceStatus.Connecting,
					InstanceStatus.Ok,
					InstanceStatus.ConnectionFailure,
					InstanceStatus.Connecting,
					InstanceStatus.Ok,
				])
				expect(errorsLogged(module)).toEqual([])
			} finally {
				await module.destroy()
				await camera.stop()
			}
		})

		// A garbled reply that's still a well-formed return message is taken as
		// the answer to the oldest unanswered inquiry, which fails for not being
		// in the expected format.  The connection is kept.

		test('reply garbled into a different return message: that inquiry fails, the connection stays ok, and Power On reaches the camera', async () => {
			const camera = await SimulatedCamera.start({ power: 'on', replies })

			const module = await ModuleUnderTest.start({
				host: '127.0.0.1',
				port: String(camera.port),
				pollEnabled: true,
				pollInterval: 100,
				pollGroups: ['power', 'position', 'lens'],
			})
			try {
				await eventually(() => {
					expect(module.variable('focus_mode')).toBe('auto')
				})

				const garbledAt = camera.received.length
				camera.replyGarbled([0x90, 0x50, 0x7f, 0x7f, 0x7f, 0xff])

				// Polling carries on past the garbled reply.
				await eventually(() => {
					expect(camera.received.length).toBeGreaterThan(garbledAt + 10)
				})

				expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])
				expect(errorsLogged(module)).toEqual([])

				// The garbled reply wasn't mistaken for a value.
				expect(module.variable('power')).toBe('on')
				expect(module.variable('focus_mode')).toBe('auto')

				await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
				await eventually(() => {
					expect(camera.received).toContainEqual(CameraPowerBytes)
				})
				expect(module.status).toBe(InstanceStatus.Ok)
			} finally {
				await module.destroy()
				await camera.stop()
			}
		})

		// One failed inquiry in an otherwise good pass doesn't mean the camera
		// lacks that inquiry: the status poller only stops sending an inquiry the
		// camera refuses pass after pass.
		test('reply garbled into a different return message: the inquiry is sent again on later passes', async () => {
			const camera = await SimulatedCamera.start({ power: 'on', replies })

			const module = await ModuleUnderTest.start({
				host: '127.0.0.1',
				port: String(camera.port),
				pollEnabled: true,
				pollInterval: 100,
				pollGroups: ['power', 'position', 'lens'],
			})
			try {
				await eventually(() => {
					expect(module.variable('focus_mode')).toBe('auto')
				})

				const garbledAt = camera.received.length
				camera.replyGarbled([0x90, 0x50, 0x7f, 0x7f, 0x7f, 0xff])
				await eventually(() => {
					expect(camera.received.length).toBeGreaterThan(garbledAt + 10)
				})

				const inquiry = camera.received[garbledAt]
				expect(camera.received.slice(garbledAt + 1)).toContainEqual(inquiry)
			} finally {
				await module.destroy()
				await camera.stop()
			}
		})

		// A reply that loses its terminator never completes, so its inquiry goes
		// unanswered.  The module gives up on it after a time limit, takes the
		// connection for lost, and reconnects.
		test('reply cut short before its terminator: the module reconnects and polling carries on', async () => {
			const camera = await SimulatedCamera.start({ power: 'on', replies })

			const module = await ModuleUnderTest.start({
				host: '127.0.0.1',
				port: String(camera.port),
				pollEnabled: true,
				pollInterval: 100,
				pollGroups: ['power', 'position', 'lens'],
			})
			try {
				await eventually(() => {
					expect(module.variable('focus_mode')).toBe('auto')
				})

				const garbledAt = camera.received.length
				camera.replyGarbled([0x90, 0x50, 0x02])
				await eventually(() => {
					expect(camera.received.length).toBeGreaterThan(garbledAt)
				})

				vi.advanceTimersByTime(InquiryTimeout)
				await eventually(() => {
					expect(camera.received.length).toBeGreaterThan(garbledAt + 10)
				})
				expect(module.statuses).toEqual([
					InstanceStatus.Connecting,
					InstanceStatus.Ok,
					InstanceStatus.ConnectionFailure,
					InstanceStatus.Connecting,
					InstanceStatus.Ok,
				])
				expect(errorsLogged(module)).toEqual([])

				// Every inquiry is still being sent, the unanswered one included.
				expect(camera.received.slice(garbledAt + 1)).toContainEqual(camera.received[garbledAt])
			} finally {
				await module.destroy()
				await camera.stop()
			}
		})

		// Bytes that can't be a return message leave the port unable to tell where
		// one reply ends and the next begins.  The port closes the connection and
		// deliberately doesn't reopen it, lest the same exchange garble again and
		// loop forever.  It stays closed until the user restarts the connection.

		test("reply garbled into bytes that aren't a return message: the connection fails until it's restarted, then Power On reaches the camera", async () => {
			const camera = await SimulatedCamera.start({ power: 'standby', replies })

			const config = {
				host: '127.0.0.1',
				port: String(camera.port),
				pollEnabled: true,
				pollInterval: 100,
			}
			let module = await ModuleUnderTest.start({ ...config })
			try {
				await eventually(() => {
					expect(module.variable('power')).toBe('standby')
				})

				camera.replyGarbled([0x12, 0x34, 0xff])
				await eventually(() => {
					expect(module.status).toBe(InstanceStatus.ConnectionFailure)
				})
				expect(errorsLogged(module)).toEqual([
					expect.stringMatching(/^Camera sent return message data not starting with z0 /),
				])

				// No attempt to reconnect is made, however long the wait.
				const receivedBefore = camera.received.length
				vi.advanceTimersByTime(10 * ReconnectInterval)
				await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
				await eventually(() => {
					expect(errorsLogged(module)).toContainEqual(
						expect.stringMatching(/^Error processing command: Socket not open to send command /),
					)
				})
				expect(module.statuses).toEqual([
					InstanceStatus.Connecting,
					InstanceStatus.Ok,
					InstanceStatus.ConnectionFailure,
				])
				expect(camera.received.length).toBe(receivedBefore)

				// Disabling and enabling the connection restarts it.
				await module.destroy()
				module = await ModuleUnderTest.start({ ...config })
				await eventually(() => {
					expect(module.variable('power')).toBe('standby')
				})
				expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])

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
