import { InstanceStatus, TCPHelper } from '@companion-module/base'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import { eventually, timePasses } from './faked-time.js'
import { ModuleUnderTest } from './module-under-test.js'
import { CameraPowerBytes } from '../visca/__tests__/camera-interactions/bytes.js'
import { HandWrittenCamera, PowerInquiryBytes } from '../visca/__tests__/simulator/cameras.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'
import type { Bytes } from '../utils/byte.js'

const ExposureModeInquiryBytes = [0x81, 0x09, 0x04, 0x39, 0xff]

/** How long the module's socket waits after a failed attempt to connect before trying again. */
const ReconnectInterval = 2000

/** How long the module gives the camera to answer a polled inquiry. */
const InquiryTimeout = 3000

/** How soon after a command the next poll pass starts. */
const PassAfterCommand = 200

/** The longest a polled inquiry waits for a command to be acknowledged. */
const WaitForAcknowledgement = 100

/** Later than the next poll pass, waits and all, could be over. */
const LateAcknowledgement = 2000

/** Longer than the module takes a camera that says it's on to be still waking. */
const AwakeAfter = 15_000

function timesReceived(camera: SimulatedCamera, message: Bytes): number {
	return camera.received.filter((received) => String(received) === String(message)).length
}

function noLongerPolled(module: ModuleUnderTest): string[] {
	return module.logs.map(({ message }) => message).filter((message) => message.includes('no longer polling'))
}

function saidUnanswered(module: ModuleUnderTest): string[] {
	return module.logs.map(({ message }) => message).filter((message) => /didn't answer a status inquiry/.test(message))
}

// A polled inquiry isn't sent while a command awaits its acknowledgement, for
// a short while.  If the connection is lost during that wait, the inquiry
// never reaches the camera: the camera has neither refused it nor left it
// unanswered.

describe('connection lost while a polled inquiry waits to be sent', () => {
	// Fake only the timers, not the sockets, so that the waits take no real
	// time and can be stepped through.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	})
	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	test('camera gone for longer than it has to answer: the inquiry is not said to be unanswered, and polling resumes when the camera is back', async () => {
		const camera = await SimulatedCamera.start({ power: 'on', replies: HandWrittenCamera.replies })

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: true,
			pollInterval: 1000,
			pollGroups: ['power'],
		})
		try {
			await eventually(() => {
				expect(module.variable('power')).toBe('on')
			})

			// A command the camera doesn't acknowledge, so that the next
			// pass, due shortly after it, waits before sending its inquiry.
			const passesBefore = timesReceived(camera, PowerInquiryBytes)
			camera.hold()
			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
			await timePasses(PassAfterCommand + WaitForAcknowledgement / 2)
			expect(camera.received.at(-1)).toEqual(CameraPowerBytes)
			expect(timesReceived(camera, PowerInquiryBytes)).toBe(passesBefore)

			// The camera goes off the network during the wait.
			camera.refuseConnections()
			camera.dropConnection()
			camera.release()
			await timePasses(InquiryTimeout + ReconnectInterval)
			expect(module.status).toBe(InstanceStatus.Connecting)
			expect(saidUnanswered(module)).toEqual([])
			expect(module.statuses).toEqual([
				InstanceStatus.Connecting,
				InstanceStatus.Ok,
				InstanceStatus.ConnectionFailure,
				InstanceStatus.Connecting,
			])

			await camera.acceptConnections()
			await eventually(() => {
				expect(module.status).toBe(InstanceStatus.Ok)
				expect(timesReceived(camera, PowerInquiryBytes)).toBeGreaterThan(passesBefore + 3)
			})
			expect(saidUnanswered(module)).toEqual([])

			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
			await eventually(() => {
				expect(timesReceived(camera, CameraPowerBytes)).toBe(2)
			})
			expect(module.status).toBe(InstanceStatus.Ok)
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})

	// The camera here lacks the exposure inquiries, and the module gives up
	// on one after the camera refuses it in a third pass.  A pass in which the
	// inquiry couldn't be sent isn't one of the three.

	/**
	 * Poll the camera until just before the pass in which the module would
	 * give up on the exposure mode inquiry.
	 *
	 * @param refusalsBeforeGivenUpOn
	 *    How many times the camera refuses the inquiry before the module
	 *    gives up on it, or null to poll until it does.
	 * @returns
	 *    How many times the camera refused the inquiry.
	 */
	async function pollUntilAboutToGiveUp(
		module: ModuleUnderTest,
		camera: SimulatedCamera,
		refusalsBeforeGivenUpOn: number | null,
	): Promise<number> {
		await eventually(() => {
			if (refusalsBeforeGivenUpOn === null) {
				expect(noLongerPolled(module)).not.toEqual([])
			} else {
				expect(timesReceived(camera, ExposureModeInquiryBytes)).toBe(refusalsBeforeGivenUpOn - 1)
			}
		}, 3 * AwakeAfter)
		return timesReceived(camera, ExposureModeInquiryBytes)
	}

	test('connection closed for good during the wait: the inquiry is not taken to have been refused', async () => {
		const config = {
			host: '127.0.0.1',
			pollEnabled: true,
			// Few enough passes that none is under way when the camera
			// comes to be taken as awake, so that the module gives up on the
			// inquiry in the same pass every time.
			pollInterval: 3000,
			pollGroups: ['power', 'exposure'],
		}

		// First find out, from a camera left alone, in which pass the module
		// gives up on the inquiry.
		let camera = await SimulatedCamera.start({ power: 'on', replies: HandWrittenCamera.replies })
		let module = await ModuleUnderTest.start({ ...config, port: String(camera.port) })
		let refusalsBeforeGivenUpOn: number
		try {
			refusalsBeforeGivenUpOn = await pollUntilAboutToGiveUp(module, camera, null)
			expect(noLongerPolled(module)[0]).toMatch(/"exposure-mode"/)
		} finally {
			await module.destroy()
			await camera.stop()
		}

		camera = await SimulatedCamera.start({ power: 'on', replies: HandWrittenCamera.replies })
		module = await ModuleUnderTest.start({ ...config, port: String(camera.port) })
		try {
			await pollUntilAboutToGiveUp(module, camera, refusalsBeforeGivenUpOn)
			await eventually(() => {
				expect(camera.received.at(-1)).not.toEqual(ExposureModeInquiryBytes)
				expect(camera.received.at(-1)).not.toEqual(PowerInquiryBytes)
			})
			await timePasses(PassAfterCommand)
			expect(noLongerPolled(module)).toEqual([])

			// In the pass that would be the third, the inquiry waits on a
			// command the camera is slow to acknowledge.  Meanwhile, straight
			// after its answer to the power inquiry, the camera sends bytes
			// that aren't a return message, at which the module closes the
			// connection for good.
			const passesBefore = timesReceived(camera, PowerInquiryBytes)
			camera.replyLate(LateAcknowledgement)
			camera.replyGarbled([0x90, 0x50, 0x02, 0xff, 0x12, 0x34, 0xff])
			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
			await eventually(() => {
				expect(module.status).toBe(InstanceStatus.ConnectionFailure)
			})
			expect(timesReceived(camera, PowerInquiryBytes)).toBe(passesBefore + 1)
			await timePasses(LateAcknowledgement)

			expect(timesReceived(camera, ExposureModeInquiryBytes)).toBe(refusalsBeforeGivenUpOn - 1)
			expect(noLongerPolled(module)).toEqual([])
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})

	// Writing to a socket can take a while.  If the module is destroyed
	// before an inquiry's bytes are written, nothing is left to tell the
	// inquiry that its connection is gone.

	test("module destroyed before an inquiry's bytes are written: no connection is made afterward", async () => {
		const camera = await SimulatedCamera.start({ power: 'on', replies: HandWrittenCamera.replies })

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: true,
			pollInterval: 1000,
			pollGroups: ['power'],
		})
		let destroyed = false
		try {
			await eventually(() => {
				expect(module.variable('power')).toBe('on')
			})

			// The one thing faked here besides the camera: the next write
			// reaches the camera, but isn't reported done until told.
			const { promise: written, resolve: reportWritten } = Promise.withResolvers<void>()
			vi.spyOn(TCPHelper.prototype, 'send').mockImplementationOnce(async function (
				this: TCPHelper,
				message: string | Buffer,
			) {
				// Only this call is faked, so this is the real write.
				const sent = await this.send(message)
				await written
				return sent
			})
			const passesBefore = timesReceived(camera, PowerInquiryBytes)
			await eventually(() => {
				expect(timesReceived(camera, PowerInquiryBytes)).toBe(passesBefore + 1)
			})

			await module.destroy()
			destroyed = true
			reportWritten()
			expect(module.status).toBe(InstanceStatus.Disconnected)
			const statusesBefore = module.statuses.length

			await timePasses(InquiryTimeout + ReconnectInterval)
			expect(module.statuses.slice(statusesBefore)).toEqual([])
			expect(saidUnanswered(module)).toEqual([])
		} finally {
			if (!destroyed) {
				await module.destroy()
			}
			await camera.stop()
		}
	})
})
