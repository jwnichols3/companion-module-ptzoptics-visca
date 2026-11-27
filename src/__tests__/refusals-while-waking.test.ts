import { InstanceStatus } from '@companion-module/base'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import { eventually, timePasses } from './faked-time.js'
import { ModuleUnderTest } from './module-under-test.js'
import { CameraPowerBytes, CommandNotExecutable } from '../visca/__tests__/camera-interactions/bytes.js'
import { HandWrittenCamera, PowerInquiryBytes } from '../visca/__tests__/simulator/cameras.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'

/** How many inquiries a poll pass of the power, position and lens groups sends. */
const InquiriesPerPass = 5

/** How long the camera goes on refusing inquiries once it says it's on: dozens of poll passes. */
const RefusesFor = 5000

/** Long enough afterward for the module to have given up on an inquiry, were it ever going to. */
const LongAfter = 30_000

function noLongerPolled(module: ModuleUnderTest): string[] {
	return module.logs.map(({ message }) => message).filter((message) => message.includes('no longer polling'))
}

// NOT A CAPTURE: no camera has been recorded doing this.  The camera captured
// so far answers nothing as it wakes, then everything.  This one stands for a
// camera that says it's on before it's ready to answer the rest.

const { on, standby } = HandWrittenCamera.replies

/** Says it's on, and refuses every other inquiry. */
const onButRefusing = {
	replies: [{ inquiry: PowerInquiryBytes, reply: [0x90, 0x50, 0x02, 0xff] }],
	otherwise: CommandNotExecutable(1),
}

describe('camera says it is on but refuses the other inquiries for a while', () => {
	// Fake only the timers, not the sockets, so that neither the waits
	// between poll passes nor the camera's refusing take real time.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	/** Check that every inquiry is still asked, pass after pass, long after the camera began answering. */
	async function expectNothingGivenUpOn(module: ModuleUnderTest, camera: SimulatedCamera): Promise<void> {
		await eventually(() => {
			expect(typeof module.variable('zoom')).toBe('number')
			expect(module.variable('focus_mode')).toBe('auto')
		})
		await timePasses(LongAfter)
		expect(new Set(camera.received.slice(-5 * InquiriesPerPass).map(String)).size).toBe(InquiriesPerPass)
		expect(noLongerPolled(module)).toEqual([])
		expect(module.status).toBe(InstanceStatus.Ok)
	}

	test('after Power On: no inquiry stops being sent, and values update once the camera answers', async () => {
		const camera = await SimulatedCamera.start({
			power: 'standby',
			replies: {
				on,
				standby,
				wakeUp: [
					{ atMs: 0, does: 'answers', replies: onButRefusing, unsolicited: [] },
					{ atMs: RefusesFor, does: 'answers', replies: on, unsolicited: [] },
				],
			},
		})

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

			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
			await eventually(() => {
				expect(module.variable('power')).toBe('on')
			})
			expect(camera.received).toContainEqual(CameraPowerBytes)

			// The camera refuses the rest, pass after pass.
			const receivedOn = camera.received.length
			await timePasses(RefusesFor / 2)
			expect(camera.received.length).toBeGreaterThan(receivedOn + 10 * InquiriesPerPass)
			expect(typeof module.variable('zoom')).not.toBe('number')

			await expectNothingGivenUpOn(module, camera)
			expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})

	test('after the connection is lost and made again: no inquiry stops being sent, and values update once the camera answers', async () => {
		const camera = await SimulatedCamera.start({ power: 'on', replies: { on, standby } })

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: true,
			pollInterval: 100,
			pollGroups: ['power', 'position', 'lens'],
		})
		try {
			// The camera has long been on and answering.
			await eventually(() => {
				expect(module.variable('focus_mode')).toBe('auto')
			})
			await timePasses(LongAfter)

			// It restarts.
			camera.answerAs(onButRefusing)
			camera.dropConnection()
			await eventually(() => {
				expect(module.statuses.slice(2)).toEqual([
					InstanceStatus.ConnectionFailure,
					InstanceStatus.Connecting,
					InstanceStatus.Ok,
				])
			})
			const receivedBack = camera.received.length
			await timePasses(RefusesFor)
			expect(camera.received.length).toBeGreaterThan(receivedBack + 10 * InquiriesPerPass)
			camera.answerAs(on)

			await expectNothingGivenUpOn(module, camera)
			expect(module.statuses).toHaveLength(5)
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})
})
