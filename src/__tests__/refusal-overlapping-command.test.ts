import { InstanceStatus } from '@companion-module/base'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import { eventually, timePasses } from './faked-time.js'
import { ModuleUnderTest } from './module-under-test.js'
import { PollGroupId } from '../status/groups.js'
import { CameraPowerBytes } from '../visca/__tests__/camera-interactions/bytes.js'
import { HandWrittenCamera } from '../visca/__tests__/simulator/cameras.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'

const CameraStandbyBytes = [0x81, 0x01, 0x04, 0x00, 0x03, 0xff]

const PanTiltPositionInquiryBytes = [0x81, 0x09, 0x06, 0x12, 0xff]

/** How soon after a command the next poll pass starts. */
const PassAfterCommand = 200

/** The longest a polled inquiry waits for a command to be acknowledged. */
const WaitForAcknowledgement = 100

function errorsLogged(module: ModuleUnderTest): string[] {
	return module.logs.filter(({ level }) => level === 'error').map(({ message }) => message)
}

// A camera in standby refuses most inquiries with Command Not Executable, and
// nothing in those bytes says which message was refused.  The port credits a
// refusal to a command awaiting its first response before any inquiry.  So
// the module must never have a polled inquiry and a command both awaiting
// their first responses.
//
// Poll without the power group, so that the camera refuses an inquiry in every
// pass.

describe('camera refuses a polled inquiry while a command is sent', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	test('Power On pressed while a refused inquiry is unanswered: the command succeeds', async () => {
		const camera = await SimulatedCamera.start({ power: 'standby', replies: HandWrittenCamera.replies })

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: true,
			pollInterval: 100,
			pollGroups: [PollGroupId.Position],
		})
		try {
			// Let the camera refuse an inquiry or two first.
			await vi.waitFor(() => {
				expect(camera.received.length).toBeGreaterThanOrEqual(2)
			})

			// Leave the next inquiry unanswered until Power On is pressed.
			camera.hold()
			const receivedBefore = camera.received.length
			await vi.waitFor(() => {
				expect(camera.received.length).toBeGreaterThan(receivedBefore)
			})
			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
			camera.release()

			await vi.waitFor(() => {
				expect(camera.power).toBe('on')
			})
			expect(camera.received).toContainEqual(CameraPowerBytes)

			// Polling carries on, now answered.
			await vi.waitFor(() => {
				expect(module.variable('pan')).toBe(-545)
			})

			expect(errorsLogged(module)).toEqual([])
			expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})

	test('command not yet acknowledged when the next poll pass is due: no inquiry is sent to be refused until it is', async () => {
		// Fake only the timers, not the sockets, so that the test can stop
		// partway through the module's wait for the acknowledgement.
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

		const camera = await SimulatedCamera.start({ power: 'standby', replies: HandWrittenCamera.replies })

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: true,
			pollInterval: 1000,
			pollGroups: [PollGroupId.Position],
		})
		try {
			// The first pass: one inquiry, refused.
			await eventually(() => {
				expect(camera.received).toEqual([PanTiltPositionInquiryBytes])
			})
			await timePasses(PassAfterCommand)
			expect(camera.received).toHaveLength(1)

			// The camera stays in standby, so it goes on refusing inquiries.
			// It receives the command and doesn't acknowledge it.
			camera.hold()
			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'off' })

			// A command speeds polling up, so the next pass is due.  Halfway
			// through the longest the pass will wait for the acknowledgement,
			// its inquiry still hasn't been sent.
			await timePasses(PassAfterCommand + WaitForAcknowledgement / 2)
			expect(camera.received).toEqual([PanTiltPositionInquiryBytes, CameraStandbyBytes])

			// Polling carries on once the command is acknowledged, each
			// inquiry refused, and the refusals are taken for nothing else.
			camera.release()
			await eventually(() => {
				expect(camera.received.length).toBeGreaterThanOrEqual(6)
			})
			expect(camera.received.slice(2)).not.toContainEqual(CameraStandbyBytes)
			expect(errorsLogged(module)).toEqual([])
			expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])

			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
			await eventually(() => {
				expect(camera.received).toContainEqual(CameraPowerBytes)
			})
			expect(camera.power).toBe('on')
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})
})
