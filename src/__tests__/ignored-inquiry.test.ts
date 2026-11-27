import { InstanceStatus } from '@companion-module/base'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import { eventually, timePasses } from './faked-time.js'
import { ModuleUnderTest } from './module-under-test.js'
import { CameraPowerBytes } from '../visca/__tests__/camera-interactions/bytes.js'
import { HandWrittenCamera, PowerInquiryBytes } from '../visca/__tests__/simulator/cameras.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'
import type { Bytes } from '../utils/byte.js'

/** How many inquiries a poll pass of the power, position and lens groups sends. */
const InquiriesPerPass = 5

/** How long the module gives the camera to answer a polled inquiry. */
const InquiryTimeout = 3000

/**
 * Longer than the module needs to give up on an inquiry the camera ignores:
 * a few passes, each a wait for an answer and then a new connection.
 */
const GivenUpWithin = 10 * InquiryTimeout

function timesReceived(camera: SimulatedCamera, message: Bytes): number {
	return camera.received.filter((received) => String(received) === String(message)).length
}

function statusesFailed(statuses: readonly InstanceStatus[]): number {
	return statuses.filter((status) => status === InstanceStatus.ConnectionFailure).length
}

function noLongerPolled(module: ModuleUnderTest): string[] {
	return module.logs.map(({ message }) => message).filter((message) => message.includes('no longer polling'))
}

// The module can't tell a camera that ignores an inquiry from a camera that's
// gone: either way no answer comes, so it takes the connection for lost and
// makes a new one.  A camera that ignores one inquiry and answers the rest
// must not keep it doing that forever.

describe('camera ignores an inquiry, sending nothing in reply', () => {
	// Fake only the timers, not the sockets, so that the waits for answers
	// that never come take no real time.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	const { on, standby } = HandWrittenCamera.replies

	test('the first inquiry of every pass ignored: it stops being sent, the connection then stays ok, and Power On reaches the camera', async () => {
		const ignoresPower = {
			...on,
			replies: on.replies.map(({ inquiry, reply }) => ({
				inquiry,
				reply: String(inquiry) === String(PowerInquiryBytes) ? [] : reply,
			})),
		}
		const camera = await SimulatedCamera.start({ power: 'on', replies: { on: ignoresPower, standby } })

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: true,
			pollInterval: 100,
			pollGroups: ['power', 'position', 'lens'],
		})
		try {
			await eventually(() => {
				expect(noLongerPolled(module)).toEqual([
					'Camera didn\'t answer the "power" status inquiry; no longer polling it',
				])
			}, GivenUpWithin)

			// The connection was taken for lost each time the inquiry went
			// unanswered.  It isn't again.
			await eventually(() => {
				expect(module.status).toBe(InstanceStatus.Ok)
			})
			const statusesBefore = module.statuses.length
			const powerInquiriesBefore = timesReceived(camera, PowerInquiryBytes)
			const receivedBefore = camera.received.length
			await timePasses(2 * GivenUpWithin)
			expect(module.statuses.length).toBe(statusesBefore)
			expect(timesReceived(camera, PowerInquiryBytes)).toBe(powerInquiriesBefore)

			// The inquiries the camera answers are still asked, pass after
			// pass, and none of them was given up on.
			expect(camera.received.length).toBeGreaterThan(receivedBefore + 10 * (InquiriesPerPass - 1))
			expect(new Set(camera.received.slice(receivedBefore).map(String)).size).toBe(InquiriesPerPass - 1)
			expect(noLongerPolled(module)).toHaveLength(1)
			expect(module.variable('pan')).toBe(-545)
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

	test('every inquiry ignored, then answered again: the connection is lost meanwhile, no inquiry stops being sent, and Power On reaches the camera', async () => {
		const camera = await SimulatedCamera.start({ power: 'on', replies: { on, standby } })

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
			expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])

			// Far longer than it takes the module to give up on one ignored
			// inquiry: a camera that answers nothing is gone, and stays
			// reported as gone for as long as it answers nothing.
			camera.hold()
			await timePasses(GivenUpWithin)
			const failedByHalfway = statusesFailed(module.statuses)
			expect(failedByHalfway).toBeGreaterThan(3)
			await timePasses(GivenUpWithin)
			expect(statusesFailed(module.statuses)).toBeGreaterThan(failedByHalfway + 3)
			expect(noLongerPolled(module)).toEqual([])

			camera.release()
			await eventually(() => {
				expect(module.status).toBe(InstanceStatus.Ok)
			})
			const statusesBack = module.statuses.length
			const receivedBack = camera.received.length
			await eventually(() => {
				expect(camera.received.length).toBeGreaterThanOrEqual(receivedBack + 10 * InquiriesPerPass)
			})
			expect(new Set(camera.received.slice(-5 * InquiriesPerPass).map(String)).size).toBe(InquiriesPerPass)
			expect(noLongerPolled(module)).toEqual([])
			expect(module.statuses.slice(statusesBack)).not.toContain(InstanceStatus.ConnectionFailure)

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
})
