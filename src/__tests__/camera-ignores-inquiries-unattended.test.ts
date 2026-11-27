import { InstanceStatus } from '@companion-module/base'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { timePasses } from './faked-time.js'
import { ModuleUnderTest } from './module-under-test.js'
import { PollGroupId } from '../status/groups.js'
import { Cameras, inquiriesIgnored, recordedIn } from '../visca/__tests__/simulator/cameras.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'
import type { Bytes } from '../utils/byte.js'

/**
 * How many times in a row the module lets an inquiry go unanswered, while
 * the camera answers others, before it gives the inquiry up.
 */
const TimesUnansweredBeforeGivenUp = 3

/**
 * Longer than the module takes, from when it's started, to give up on every
 * inquiry the cameras captured so far ignore.
 */
const GivenUpWithin = 15_000

/**
 * Longer than a poll pass takes, start to start, while the module finds out
 * what the camera ignores: how stale a value the camera does answer can get.
 */
const PassesNoFurtherApart = 6000

/** An inquiry sent once in every pass, and never as a probe. */
const ZoomPositionInquiryBytes = [0x81, 0x09, 0x04, 0x47, 0xff]

function timesReceived(camera: SimulatedCamera, message: Bytes): number {
	return camera.received.filter((received) => String(received) === String(message)).length
}

function noLongerPolled(module: ModuleUnderTest): string[] {
	return module.logs.map(({ message }) => message).filter((message) => message.includes('no longer polling'))
}

function logged(module: ModuleUnderTest, ...levels: string[]): string[] {
	return module.logs.filter(({ level }) => levels.includes(level)).map(({ message }) => message)
}

/** The cameras recorded, while on, ignoring some of the inquiries the module polls. */
const CamerasIgnoringInquiries = Cameras.flatMap((camera) =>
	recordedIn(camera, ['on']) && inquiriesIgnored(camera.replies.on) > 0 ? [camera] : [],
)

// How long the module takes to find out which inquiries a camera ignores, and
// what becomes meanwhile of the values the camera does answer.
//
// With no command sent the module polls at its slowest, so this is the
// longest the finding out takes.  Each pass meanwhile is held up by a short
// wait on each inquiry the camera ignores, so what the camera does answer is
// read less often than it will be.  (`camera-ignores-inquiries.test.ts` has
// an operator pressing buttons throughout.)

describe.each(CamerasIgnoringInquiries)(
	'camera ignores some inquiries, sending nothing in reply, and no command is sent: $name',
	({ replies }) => {
		// Fake only the timers, not the sockets, so that the waits for answers
		// that never come take no real time.
		beforeEach(() => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		})
		afterEach(() => {
			vi.useRealTimers()
		})

		const ignored = replies.on.replies.filter(({ reply }) => reply === null).map(({ inquiry }) => inquiry)

		test('Generic VISCA: each is given up within fifteen seconds, in three passes that start no more than six seconds apart', async () => {
			// As slow to answer as the real camera was: one answer in each
			// pass took it a third of a second.
			const camera = await SimulatedCamera.start({ power: 'on', replies, latencyMs: 'recorded' })

			// Every setting but these takes its default.
			const module = await ModuleUnderTest.start({
				host: '127.0.0.1',
				port: String(camera.port),
				pollEnabled: true,
				pollGroups: Object.values(PollGroupId),
			})

			try {
				let passesStarted = 0
				let passStartedAt = 0
				for (let passed = 0; noLongerPolled(module).length < ignored.length; passed += 10) {
					expect(passed, 'the module took too long to give up on the inquiries the camera ignores').toBeLessThan(
						GivenUpWithin,
					)
					await timePasses(10)

					const passesStartedNow = timesReceived(camera, ZoomPositionInquiryBytes)
					if (passesStartedNow > passesStarted) {
						passesStarted = passesStartedNow
						passStartedAt = passed
					}
					expect(passed - passStartedAt, 'too long went by with no poll pass started').toBeLessThan(
						PassesNoFurtherApart,
					)
				}

				expect(passesStarted).toBe(TimesUnansweredBeforeGivenUp)
				expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])
				expect(logged(module, 'warn', 'error')).toEqual([])
				expect(camera.connectionsAccepted).toBe(1)
			} finally {
				await module.destroy()
				await camera.stop()
			}
		})
	},
)
