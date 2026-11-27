import { InstanceStatus } from '@companion-module/base'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import { ModuleUnderTest } from './module-under-test.js'
import { PollGroupId } from '../status/groups.js'
import { CameraPowerBytes } from '../visca/__tests__/camera-interactions/bytes.js'
import { HandWrittenCamera } from '../visca/__tests__/simulator/cameras.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'

const CameraStandbyBytes = [0x81, 0x01, 0x04, 0x00, 0x03, 0xff]

/** How late the camera acknowledges a command: later than the next poll pass starts. */
const LateAcknowledgement = 250

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

	test('command acknowledged late: no inquiry is sent to be refused meanwhile', async () => {
		// Fake only the timers, not the sockets, so that lateness takes no
		// real time.  `vi.waitFor` advances the fake timers a little every
		// time it checks.
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
			await vi.waitFor(() => {
				expect(camera.received.length).toBe(1)
			})

			// The camera stays in standby, so it goes on refusing inquiries.
			camera.replyLate(LateAcknowledgement)
			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'off' })

			// A command speeds polling up, so the next pass is due before the
			// acknowledgement.  Let a few passes go by.
			await vi.waitFor(() => {
				expect(camera.received.length).toBeGreaterThanOrEqual(5)
			})
			expect(camera.received[1]).toEqual(CameraStandbyBytes)

			expect(errorsLogged(module)).toEqual([])
			expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})
})
