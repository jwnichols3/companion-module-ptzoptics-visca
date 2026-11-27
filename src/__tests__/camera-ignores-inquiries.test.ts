import { InstanceStatus } from '@companion-module/base'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import { PresetActionId, PresetAsNumberId, PresetIsTextId } from '../actions/presets.js'
import { eventually, timePasses } from './faked-time.js'
import { ModuleUnderTest } from './module-under-test.js'
import { PollGroupId } from '../status/groups.js'
import { CameraPowerBytes, PresetRecallBytes } from '../visca/__tests__/camera-interactions/bytes.js'
import { Cameras, inquiriesIgnored, recordedIn } from '../visca/__tests__/simulator/cameras.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'
import type { Bytes } from '../utils/byte.js'

/** The interval between poll passes when the config doesn't give one. */
const DefaultPollInterval = 1000

/** How long the module gives the camera to answer a polled inquiry. */
const InquiryTimeout = 3000

/**
 * How many times in a row the module lets an inquiry go unanswered, while
 * the camera answers others, before it gives the inquiry up.
 */
const TimesUnansweredBeforeGivenUp = 3

/** A command is sent this often while the module finds out what the camera ignores. */
const CommandEvery = 700

/** The preset numbers the commands recall, in turn. */
const Presets = 80

/** What the module logs of a command whose acknowledgement it was waiting on when it took the connection for lost. */
const AcknowledgementCutOff = 'Unhandled command rejection was suppressed: Error: Camera stopped answering'

/** Longer than sixty poll passes take at the default interval. */
const SixtyPasses = 90_000

function timesReceived(camera: SimulatedCamera, messages: readonly Bytes[]): number {
	return camera.received.filter((received) => messages.some((message) => String(received) === String(message))).length
}

function statusesFailed(statuses: readonly InstanceStatus[]): number {
	return statuses.filter((status) => status === InstanceStatus.ConnectionFailure).length
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

// Some cameras answer nothing at all to an inquiry they don't have, where
// others refuse it.  The module can't tell an inquiry ignored from a camera
// gone, so each time one goes unanswered it takes the connection for lost and
// makes a new one.  With the Generic VISCA camera model it asks everything,
// and finds out what the camera ignores only by asking.
//
// THIS IS WHAT THAT COSTS TODAY, NOT WHAT IT SHOULD COST.  Every inquiry the
// camera ignores is asked `TimesUnansweredBeforeGivenUp` times, and each time
// costs `InquiryTimeout` of waiting, a connection reported failed, and a
// warning.  A camera that ignores five inquiries, as the cameras captured so
// far do, takes fifteen reconnects and over a minute at the default poll
// interval before the connection stays ok.  The module remembers what it gave
// up on for as long as its settings are unchanged, so a connection lost and
// made again later doesn't cost it again; a change of settings, or Companion
// starting, does.

describe.each(CamerasIgnoringInquiries)(
	'camera ignores some inquiries, sending nothing in reply: $name',
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

		/**
		 * Longer than the module needs to give up on every inquiry the camera
		 * ignores: for each time one is asked, a pass of slow answers, the
		 * wait for the answer that doesn't come, and a new connection.
		 */
		const GivenUpWithin = TimesUnansweredBeforeGivenUp * ignored.length * (InquiryTimeout + 3 * DefaultPollInterval)

		test('Generic VISCA: each is given up after three reconnects, no command is lost meanwhile, and polling is then quiet for good', async () => {
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

			const pressed: Bytes[] = []
			const recallPreset = async () => {
				const preset = 1 + (pressed.length % Presets)
				pressed.push(PresetRecallBytes(preset))
				await module.executeAction(PresetActionId.RecallPreset, {
					[PresetIsTextId]: false,
					[PresetAsNumberId]: preset,
				})
			}
			const commandsReceived = () => camera.received.filter(([, type]) => type === 0x01)

			try {
				// An operator goes on pressing buttons all the while: every
				// so often, and at once each time the connection is reported
				// failed, when the module is making a new one.
				let failed = 0
				for (let passed = 0; noLongerPolled(module).length < ignored.length; passed += 10) {
					expect(passed, 'the module never gave up on the inquiries the camera ignores').toBeLessThan(GivenUpWithin)
					await timePasses(10)

					const failedNow = statusesFailed(module.statuses)
					if (failedNow > failed || passed % CommandEvery === 0) {
						failed = failedNow
						await recallPreset()
					}
				}
				await eventually(() => {
					expect(module.status).toBe(InstanceStatus.Ok)
				})

				// What it cost.
				expect(statusesFailed(module.statuses)).toBe(TimesUnansweredBeforeGivenUp * ignored.length)
				expect(logged(module, 'warn')).toEqual(
					Array.from(
						{ length: TimesUnansweredBeforeGivenUp * ignored.length },
						() => `Camera didn't answer a status inquiry within ${InquiryTimeout} ms; reconnecting`,
					),
				)
				expect(timesReceived(camera, ignored)).toBe(TimesUnansweredBeforeGivenUp * ignored.length)

				// Every command reached the camera, once, in the order pressed.
				await eventually(() => {
					expect(commandsReceived()).toEqual(pressed)
				})
				expect(pressed.length).toBeGreaterThan(TimesUnansweredBeforeGivenUp * ignored.length)

				// A command sent just as the module gives up on an inquiry
				// is cut off from its acknowledgement by the new connection:
				// the camera has it, but the module logs that it failed.
				// Nothing else is logged as an error.
				expect(logged(module, 'error').filter((message) => message !== AcknowledgementCutOff)).toEqual([])

				// From here on polling is quiet: sixty passes and more with
				// nothing ignored asked again, no status reported, and nothing
				// logged, while what the camera does answer keeps updating.
				const statusesBefore = module.statuses.length
				const logsBefore = logged(module, 'info', 'warn', 'error').length
				const receivedBefore = camera.received.length
				await timePasses(SixtyPasses)
				expect(timesReceived(camera, [[0x81, 0x09, 0x04, 0x00, 0xff]])).toBeGreaterThan(60)
				expect(camera.received.length).toBeGreaterThan(
					receivedBefore + 60 * (replies.on.replies.length - ignored.length),
				)
				expect(timesReceived(camera, ignored)).toBe(TimesUnansweredBeforeGivenUp * ignored.length)
				expect(module.statuses.length).toBe(statusesBefore)
				expect(logged(module, 'info', 'warn', 'error').length).toBe(logsBefore)
				expect(module.variable('power')).toBe('on')
				expect(module.variable('saturation')).toBeTypeOf('number')

				// A connection lost and made again doesn't cost it all again.
				camera.dropConnection()
				await eventually(() => {
					expect(statusesFailed(module.statuses)).toBe(TimesUnansweredBeforeGivenUp * ignored.length + 1)
				})
				await eventually(() => {
					expect(module.status).toBe(InstanceStatus.Ok)
				})
				await timePasses(SixtyPasses)
				expect(timesReceived(camera, ignored)).toBe(TimesUnansweredBeforeGivenUp * ignored.length)
				expect(statusesFailed(module.statuses)).toBe(TimesUnansweredBeforeGivenUp * ignored.length + 1)
				expect(noLongerPolled(module)).toHaveLength(ignored.length)

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
	},
)
