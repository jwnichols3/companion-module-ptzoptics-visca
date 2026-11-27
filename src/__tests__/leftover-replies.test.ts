import { InstanceStatus } from '@companion-module/base'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import type { CameraPowerState } from '../camera/power.js'
import { describeEachCamera, stateInWords } from './each-camera.js'
import { eventually, timePasses } from './faked-time.js'
import { ModuleUnderTest } from './module-under-test.js'
import { CommandNotExecutable } from '../visca/__tests__/camera-interactions/bytes.js'
import { PowerInquiryBytes } from '../visca/__tests__/simulator/cameras.js'
import { SimulatedCamera, type StateReplies } from '../visca/__tests__/simulator/simulated-camera.js'
import type { Bytes } from '../utils/byte.js'

/** The interval between poll passes when the config doesn't give one. */
const DefaultPollInterval = 1000

const ZoomPositionInquiryBytes = [0x81, 0x09, 0x04, 0x47, 0xff]
const ZoomedTo = 0x1234
const ZoomedToAnswer = [0x90, 0x50, 0x01, 0x02, 0x03, 0x04, 0xff]

const PowerCommandBytes = {
	on: [0x81, 0x01, 0x04, 0x00, 0x02, 0xff],
	off: [0x81, 0x01, 0x04, 0x00, 0x03, 0xff],
}

function timesReceived(camera: SimulatedCamera, message: Bytes): number {
	return camera.received.filter((received) => String(received) === String(message)).length
}

function logged(module: ModuleUnderTest, ...levels: string[]): string[] {
	return module.logs.filter(({ level }) => levels.includes(level)).map(({ message }) => message)
}

/** The camera's answers, but with its zoom at `ZoomedTo`. */
function zoomed({ replies, otherwise }: StateReplies): StateReplies {
	return {
		replies: replies.map(({ inquiry, reply }) => ({
			inquiry,
			reply: String(inquiry) === String(ZoomPositionInquiryBytes) ? ZoomedToAnswer : reply,
		})),
		otherwise,
	}
}

// Seen 2026-11-27: cameras that close their side of the connection every
// twelve hours, to the minute.  The module makes a new connection at once,
// and on it the camera delivers its replies to the inquiries that were
// unanswered when it closed the old one: answers, or, from a camera in
// standby, Command Not Executable.  Nothing has been asked on the new
// connection yet, so they are the replies to nothing.  Taken for a sign that
// the module and the camera had lost track of each other, they once closed
// the connection for good, until someone disabled and enabled it.

function scenarios<Power extends CameraPowerState>(power: Power): void {
	describeEachCamera(
		`camera ${stateInWords(power)} closes the connection with an inquiry unanswered, then sends leftover replies on the next`,
		[power],
		({ replies: { on, standby } }) => {
			// How a camera wakes is for other scenarios: this one is on as soon as
			// it's told to be.
			const replies = { on, standby }

			// Fake only the timers, not the sockets, so that the waits between
			// poll passes take no real time, and the leftover replies can be
			// sent during one.
			beforeEach(() => {
				vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
			})
			afterEach(() => {
				vi.useRealTimers()
			})

			/**
			 * A leftover answer.  Taken for the answer to the power inquiry
			 * it would read the power state the camera isn't in.
			 */
			const LeftoverAnswer = power === 'on' ? [0x90, 0x50, 0x03, 0xff] : [0x90, 0x50, 0x02, 0xff]
			const LeftoverRefusal = CommandNotExecutable(1)

			// A camera never recorded on can't be told to power on.  Telling
			// it to go to standby, where it is already, still shows that a
			// command reaches it.
			const command = on === undefined ? 'off' : 'on'

			test(`the replies are ignored: the connection is ok again without user action, polling resumes, values update, and Power ${command === 'on' ? 'On' : 'Off'} reaches the camera`, async () => {
				const camera = await SimulatedCamera.start({ power, replies })

				// Every setting but these takes its default.
				const module = await ModuleUnderTest.start({
					host: '127.0.0.1',
					port: String(camera.port),
					pollEnabled: true,
				})
				try {
					await eventually(() => {
						expect(module.variable('power')).toBe(power)
					})
					expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])

					// The camera closes the connection with an inquiry sent
					// and not yet answered.
					camera.hold()
					const receivedBefore = camera.received.length
					await eventually(() => {
						expect(camera.received.length).toBeGreaterThan(receivedBefore)
					}, 2 * DefaultPollInterval)
					camera.dropConnection()
					camera.release()

					// The module makes a new connection at once, and has
					// asked nothing on it when the leftover replies arrive.
					await eventually(() => {
						expect(camera.connectionsAccepted).toBe(2)
						expect(module.statuses).toEqual([
							InstanceStatus.Connecting,
							InstanceStatus.Ok,
							InstanceStatus.ConnectionFailure,
							InstanceStatus.Connecting,
							InstanceStatus.Ok,
						])
					})
					const receivedOnOldConnection = camera.received.length
					camera.send([...LeftoverAnswer, ...LeftoverRefusal])
					await timePasses(DefaultPollInterval / 4)

					// They close nothing, and are kept for nothing.
					expect(module.statuses.slice(5)).toEqual([])
					expect(logged(module, 'error')).toEqual(['Network error: camera closed its side of the connection'])
					expect(camera.received.length).toBe(receivedOnOldConnection)
					expect(logged(module, 'debug')).toEqual(
						expect.arrayContaining([
							`Ignoring unsolicited inquiry response [90 50 0${LeftoverAnswer[2]} FF]`,
							'Ignoring unsolicited error response [90 61 41 FF]',
						]),
					)

					// Polling resumes on the new connection, pass after pass,
					// and the connection is never reported as anything but ok
					// again.
					const passesBefore = timesReceived(camera, PowerInquiryBytes)
					await timePasses(10 * DefaultPollInterval)
					expect(timesReceived(camera, PowerInquiryBytes)).toBeGreaterThan(passesBefore + 5)
					expect(module.statuses).toHaveLength(5)
					expect(module.variable('power')).toBe(power)

					// Values still follow the camera.
					if (on !== undefined && power === 'on') {
						expect(module.variable('zoom')).not.toBe(ZoomedTo)
						camera.answerAs(zoomed(on))
						await eventually(() => {
							expect(module.variable('zoom')).toBe(ZoomedTo)
						})
					}

					// Only the connection closing was an error, and nothing
					// was given up on.
					expect(logged(module, 'error')).toEqual(['Network error: camera closed its side of the connection'])
					expect(logged(module, 'warn')).toEqual([])
					expect(module.logs.filter(({ message }) => message.includes('no longer polling'))).toEqual([])

					await module.executeAction(PowerActionId.CameraPowerState, { bool: command })
					await eventually(() => {
						expect(camera.received).toContainEqual(PowerCommandBytes[command])
					})
					if (command === 'on') {
						await eventually(() => {
							expect(module.variable('power')).toBe('on')
						})
					}
					expect(camera.power).toBe(command === 'on' ? 'on' : 'standby')
					expect(module.statuses).toHaveLength(5)
					expect(module.status).toBe(InstanceStatus.Ok)
				} finally {
					await module.destroy()
					await camera.stop()
				}
			})
		},
	)
}

scenarios('on')
scenarios('standby')
