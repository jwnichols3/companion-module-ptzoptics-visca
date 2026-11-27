import { InstanceStatus } from '@companion-module/base'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import { ModuleUnderTest } from './module-under-test.js'
import { CameraPowerBytes } from '../visca/__tests__/camera-interactions/bytes.js'
import { PowerInquiryBytes, RecordedReplies } from '../visca/__tests__/simulator/recorded-replies.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'

/** How long the module's socket waits after a failed attempt to connect before trying again. */
const ReconnectInterval = 2000

/** How late a late reply is: several poll intervals. */
const Late = 1000

function errorsLogged(module: ModuleUnderTest): string[] {
	return module.logs.filter(({ level }) => level === 'error').map(({ message }) => message)
}

describe('a reply from the camera arrives late or garbled', () => {
	// Fake only the timers, not the sockets, so that lateness takes no real
	// time.  `vi.waitFor` advances the fake timers a little every time it
	// checks.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	// The port sets no time limit on a reply, so a late reply fails nothing:
	// it answers its inquiry whenever it arrives.

	test('one reply late: a Power On sent meanwhile reaches the camera, and nothing fails', async () => {
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

			const receivedBefore = camera.received.length
			camera.replyLate(Late)
			await vi.waitFor(() => {
				expect(camera.received.length).toBeGreaterThan(receivedBefore)
			})

			// The command doesn't wait behind the unanswered inquiry.
			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
			await vi.waitFor(() => {
				expect(camera.power).toBe('on')
			})
			expect(camera.received.slice(receivedBefore)).toEqual([PowerInquiryBytes, CameraPowerBytes])

			// Once the late reply is in, polling carries on.
			vi.advanceTimersByTime(Late)
			await vi.waitFor(() => {
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

			const receivedBefore = camera.received.length
			camera.stall(Late)
			await vi.waitFor(() => {
				expect(camera.received.length).toBeGreaterThan(receivedBefore)
			})

			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
			await vi.waitFor(() => {
				expect(camera.received.slice(receivedBefore)).toEqual([PowerInquiryBytes, CameraPowerBytes])
			})
			expect(camera.power).toBe('standby')

			vi.advanceTimersByTime(Late)
			await vi.waitFor(() => {
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

	// A garbled reply that's still a well-formed return message is taken as
	// the answer to the oldest unanswered inquiry, which fails for not being
	// in the expected format.  The connection is kept.

	test('reply garbled into a different return message: that inquiry fails, the connection stays ok, and Power On reaches the camera', async () => {
		const camera = await SimulatedCamera.start({ power: 'on', replies: RecordedReplies })

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: true,
			pollInterval: 100,
			pollGroups: ['power', 'position', 'lens'],
		})
		try {
			await vi.waitFor(() => {
				expect(module.variable('focus_mode')).toBe('auto')
			})

			const garbledAt = camera.received.length
			camera.replyGarbled([0x90, 0x50, 0x7f, 0x7f, 0x7f, 0xff])

			// Polling carries on past the garbled reply.
			await vi.waitFor(() => {
				expect(camera.received.length).toBeGreaterThan(garbledAt + 10)
			})

			expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])
			expect(errorsLogged(module)).toEqual([])

			// The garbled reply wasn't mistaken for a value.
			expect(module.variable('power')).toBe('on')
			expect(module.variable('focus_mode')).toBe('auto')

			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
			await vi.waitFor(() => {
				expect(camera.received).toContainEqual(CameraPowerBytes)
			})
			expect(module.status).toBe(InstanceStatus.Ok)
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})

	// BUG: the status poller takes one failed inquiry in an otherwise good
	// pass to mean the camera doesn't support that inquiry, and never sends it
	// again.  So one garbled reply stops a value updating until the settings
	// are changed.  This test fails until the poller tells a reply garbled
	// once from an inquiry the camera never answers.
	test.fails('reply garbled into a different return message: the inquiry is sent again on later passes', async () => {
		const camera = await SimulatedCamera.start({ power: 'on', replies: RecordedReplies })

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: true,
			pollInterval: 100,
			pollGroups: ['power', 'position', 'lens'],
		})
		try {
			await vi.waitFor(() => {
				expect(module.variable('focus_mode')).toBe('auto')
			})

			const garbledAt = camera.received.length
			camera.replyGarbled([0x90, 0x50, 0x7f, 0x7f, 0x7f, 0xff])
			await vi.waitFor(() => {
				expect(camera.received.length).toBeGreaterThan(garbledAt + 10)
			})

			const inquiry = camera.received[garbledAt]
			expect(camera.received.slice(garbledAt + 1)).toContainEqual(inquiry)
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})

	// BUG: the status poller waits without limit for the answer to each
	// inquiry before sending the next.  A reply that loses its terminator
	// never completes, so polling stops for good while the connection still
	// reads ok.  This test fails until the poller gives up on an inquiry that
	// goes unanswered.
	test.fails('reply cut short before its terminator: polling carries on', async () => {
		const camera = await SimulatedCamera.start({ power: 'on', replies: RecordedReplies })

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: true,
			pollInterval: 100,
			pollGroups: ['power', 'position', 'lens'],
		})
		try {
			await vi.waitFor(() => {
				expect(module.variable('focus_mode')).toBe('auto')
			})

			const garbledAt = camera.received.length
			camera.replyGarbled([0x90, 0x50, 0x02])

			vi.advanceTimersByTime(60 * 1000)
			await vi.waitFor(
				() => {
					expect(camera.received.length).toBeGreaterThan(garbledAt + 1)
				},
				{ timeout: 250 },
			)
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
		const camera = await SimulatedCamera.start({ power: 'standby', replies: RecordedReplies })

		const config = {
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: true,
			pollInterval: 100,
		}
		let module = await ModuleUnderTest.start({ ...config })
		try {
			await vi.waitFor(() => {
				expect(module.variable('power')).toBe('standby')
			})

			camera.replyGarbled([0x12, 0x34, 0xff])
			await vi.waitFor(() => {
				expect(module.status).toBe(InstanceStatus.ConnectionFailure)
			})
			expect(errorsLogged(module)).toEqual([
				expect.stringMatching(/^Camera sent return message data not starting with z0 /),
			])

			// No attempt to reconnect is made, however long the wait.
			const receivedBefore = camera.received.length
			vi.advanceTimersByTime(10 * ReconnectInterval)
			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
			await vi.waitFor(() => {
				expect(errorsLogged(module)).toContainEqual(
					expect.stringMatching(/^Error processing command: Socket not open to send command /),
				)
			})
			expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok, InstanceStatus.ConnectionFailure])
			expect(camera.received.length).toBe(receivedBefore)

			// Disabling and enabling the connection restarts it.
			await module.destroy()
			module = await ModuleUnderTest.start({ ...config })
			await vi.waitFor(() => {
				expect(module.variable('power')).toBe('standby')
			})
			expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])

			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
			await vi.waitFor(() => {
				expect(camera.received).toContainEqual(CameraPowerBytes)
			})
			expect(camera.power).toBe('on')
			await vi.waitFor(() => {
				expect(module.variable('power')).toBe('on')
			})
			expect(module.status).toBe(InstanceStatus.Ok)
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})
})
