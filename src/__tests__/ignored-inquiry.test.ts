import { InstanceStatus } from '@companion-module/base'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import { eventually, timePasses } from './faked-time.js'
import { ModuleUnderTest } from './module-under-test.js'
import { CameraPowerBytes } from '../visca/__tests__/camera-interactions/bytes.js'
import { HandWrittenCamera, PowerInquiryBytes } from '../visca/__tests__/simulator/cameras.js'
import { SimulatedCamera, type StateReplies } from '../visca/__tests__/simulator/simulated-camera.js'
import type { Bytes } from '../utils/byte.js'

/** How many inquiries a poll pass of the power, position and lens groups sends. */
const InquiriesPerPass = 5

/** How long the module gives the camera to answer a polled inquiry. */
const InquiryTimeout = 3000

const FocusPositionInquiryBytes = [0x81, 0x09, 0x04, 0x48, 0xff]

/**
 * Longer than the module needs to give up on an inquiry the camera ignores,
 * even when each pass costs it a wait for an answer and then a new
 * connection.
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

function warnings(module: ModuleUnderTest): string[] {
	return module.logs.filter(({ level }) => level === 'warn').map(({ message }) => message)
}

/** The camera's replies while on, but with nothing sent in reply to the given inquiry. */
function ignoring(replies: StateReplies, ignored: Bytes): StateReplies {
	return {
		...replies,
		replies: replies.replies.map(({ inquiry, reply }) => ({
			inquiry,
			reply: String(inquiry) === String(ignored) ? null : reply,
		})),
	}
}

// A camera that ignores an inquiry isn't gone.  When an inquiry isn't answered
// promptly the module sends another, a probe, whose answer it can tell from an
// answer to the first: a camera that answers the probe is there, and the
// connection is kept.  Only a camera that answers neither is taken for gone.
// An inquiry the camera ignores pass after pass stops being sent.

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

	// Power is the first inquiry of the first pass, so when it goes
	// unanswered the camera hasn't yet answered anything: the probe is an
	// inquiry it's only hoped to answer.
	test('the first inquiry of every pass ignored: it stops being sent, the connection stays ok throughout, and Power On reaches the camera', async () => {
		const camera = await SimulatedCamera.start({
			power: 'on',
			replies: { on: ignoring(on, PowerInquiryBytes), standby },
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
				expect(noLongerPolled(module)).toEqual([
					'Camera didn\'t answer the "power" status inquiry; no longer polling it',
				])
			}, GivenUpWithin)

			// The connection was never taken for lost, and isn't later.
			expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])
			expect(warnings(module)).toEqual([])
			expect(camera.connectionsAccepted).toBe(1)
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

	// The probe needn't be the power inquiry.
	test('power not polled, and an inquiry ignored: it stops being sent, and the connection stays ok throughout', async () => {
		const camera = await SimulatedCamera.start({
			power: 'on',
			replies: { on: ignoring(on, FocusPositionInquiryBytes), standby },
		})

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: true,
			pollInterval: 100,
			pollGroups: ['position', 'lens'],
		})
		try {
			await eventually(() => {
				expect(noLongerPolled(module)).toEqual([
					'Camera didn\'t answer the "focus" status inquiry; no longer polling it',
				])
			}, GivenUpWithin)

			expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])
			expect(warnings(module)).toEqual([])
			expect(camera.connectionsAccepted).toBe(1)
			expect(timesReceived(camera, FocusPositionInquiryBytes)).toBe(3)
			expect(timesReceived(camera, PowerInquiryBytes)).toBe(0)

			// What the camera answers was never mistaken for an answer to
			// what it ignores.
			expect(module.variable('focus')).not.toBeTypeOf('number')
			expect(module.variable('pan')).toBe(-545)
			expect(module.variable('zoom')).toBe(0x28f7)
			expect(module.variable('focus_mode')).toBe('auto')
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})

	// The module can tell an answer to the probe from an answer to the
	// inquiry only if the two differ in length.  Polling only inquiries with
	// answers of one length leaves it no probe: then it can't tell a camera
	// that ignores an inquiry from a camera that's gone, and each time the
	// inquiry goes unanswered it takes the connection for lost and makes a
	// new one.
	test('no polled inquiry can be a probe, and an inquiry ignored: the connection is taken for lost each time, and the inquiry still stops being sent', async () => {
		const FlipInquiryBytes = [0x81, 0x09, 0x04, 0x66, 0xff]
		const MirrorInquiryBytes = [0x81, 0x09, 0x04, 0x61, 0xff]
		const camera = await SimulatedCamera.start({
			power: 'on',
			replies: {
				on: {
					...on,
					replies: [
						...on.replies,
						{ inquiry: FlipInquiryBytes, reply: null },
						{ inquiry: MirrorInquiryBytes, reply: [0x90, 0x50, 0x03, 0xff] },
					],
				},
				standby,
			},
		})

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: true,
			pollInterval: 100,
			pollGroups: ['power', 'image'],
		})
		try {
			await eventually(() => {
				expect(noLongerPolled(module)).toEqual([
					'Camera didn\'t answer the "flip" status inquiry; no longer polling it',
				])
			}, GivenUpWithin)
			await eventually(() => {
				expect(module.status).toBe(InstanceStatus.Ok)
			})

			expect(statusesFailed(module.statuses)).toBe(3)
			expect(warnings(module)).toEqual(
				Array.from(
					{ length: 3 },
					() => `Camera didn't answer a status inquiry within ${InquiryTimeout} ms; reconnecting`,
				),
			)
			expect(timesReceived(camera, FlipInquiryBytes)).toBe(3)

			const statusesBefore = module.statuses.length
			await timePasses(GivenUpWithin)
			expect(module.statuses.length).toBe(statusesBefore)
			expect(timesReceived(camera, FlipInquiryBytes)).toBe(3)
			expect(module.variable('power')).toBe('on')
			expect(module.variable('mirror')).toBe('off')
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
