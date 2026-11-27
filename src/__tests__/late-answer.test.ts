import { InstanceStatus } from '@companion-module/base'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { eventually, timePasses } from './faked-time.js'
import { ModuleUnderTest } from './module-under-test.js'
import { HandWrittenCamera, PowerInquiryBytes } from '../visca/__tests__/simulator/cameras.js'
import { SimulatedCamera, type StateReplies } from '../visca/__tests__/simulator/simulated-camera.js'

/** How many inquiries a poll pass of the power, position and lens groups sends. */
const InquiriesPerPass = 5

/** How long the module gives the camera to answer a polled inquiry before it sends a probe after it. */
const ProbeAfter = 500

/** The interval between poll passes when the config doesn't give one. */
const DefaultPollInterval = 1000

function logged(module: ModuleUnderTest, ...levels: string[]): string[] {
	return module.logs.filter(({ level }) => levels.includes(level)).map(({ message }) => message)
}

function noLongerPolled(module: ModuleUnderTest): string[] {
	return logged(module, 'info').filter((message) => message.includes('no longer polling'))
}

/** Every polled value as the hand-written camera's replies give it, while on. */
const ValuesOn = { power: 'on', pan: -545, tilt: -68, zoom: 0x28f7, focus: 0x0772, focus_mode: 'auto' }

function values(module: ModuleUnderTest): Record<string, unknown> {
	return Object.fromEntries(Object.keys(ValuesOn).map((id) => [id, module.variable(id)]))
}

// When a polled inquiry isn't answered promptly the module sends a probe
// after it, and an answer to the probe shows that the camera ignored the
// inquiry.  The inquiry's own answer may still come, late.  It must never be
// taken for the answer to another inquiry.

describe('answer to a polled inquiry arrives after the module has sent a probe', () => {
	// Fake only the timers, not the sockets, so that lateness takes no real
	// time.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	const { on, standby } = HandWrittenCamera.replies

	// A camera answers in order, so one that's only slow over an inquiry
	// answers it before it answers the probe.

	test('camera slow over every answer, answering in order: each inquiry is given its own answer, nothing is given up, and the connection stays ok', async () => {
		// Every reply is sent longer after its message than the module
		// waits before it sends a probe: so every inquiry is followed by a
		// probe, and answered ahead of it.
		const camera = await SimulatedCamera.start({
			power: 'on',
			replies: { on, standby },
			latencyMs: ProbeAfter + 100,
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
				expect(values(module)).toEqual(ValuesOn)
			}, 10_000)

			// Many more passes than an inquiry may go unanswered in before
			// it's given up.
			const receivedBefore = camera.received.length
			await eventually(() => {
				expect(camera.received.length).toBeGreaterThan(receivedBefore + 2 * 6 * InquiriesPerPass)
			}, 60_000)

			// Every inquiry was followed by a probe.
			expect(camera.received.length % 2).toBeLessThanOrEqual(1)
			expect(
				camera.received.filter((message, i) => i % 2 === 0 && String(message) === String(camera.received[i + 1])),
			).toEqual([])

			expect(values(module)).toEqual(ValuesOn)
			expect(noLongerPolled(module)).toEqual([])
			expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])
			expect(logged(module, 'warn', 'error')).toEqual([])
			expect(camera.connectionsAccepted).toBe(1)
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})

	// A camera that answered the probe first has, if it answers in order,
	// no answer left to send.  Were one to come all the same, between
	// passes, nothing awaits an answer: it's ignored.

	test('one answer sent after the answer to the probe, between passes: it is ignored, and no value changes', async () => {
		/** While on, but saying to the power inquiry what a camera in standby says. */
		const sayingStandby: StateReplies = {
			...on,
			replies: on.replies.map(({ inquiry, reply }) => ({
				inquiry,
				reply: String(inquiry) === String(PowerInquiryBytes) ? [0x90, 0x50, 0x03, 0xff] : reply,
			})),
		}
		const camera = await SimulatedCamera.start({ power: 'on', replies: { on, standby } })

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: true,
			pollGroups: ['power', 'position', 'lens'],
		})
		try {
			await eventually(() => {
				expect(values(module)).toEqual(ValuesOn)
			})

			// The next inquiry is the power inquiry that starts a pass.
			// Its answer is sent when the pass it started is over and the
			// next not yet begun.  Read as power the answer says standby,
			// and read as focus mode, manual.
			const receivedBefore = camera.received.length
			expect(receivedBefore % InquiriesPerPass).toBe(0)
			camera.answerAs(sayingStandby)
			camera.replyLate(ProbeAfter + DefaultPollInterval / 2)
			await eventually(() => {
				expect(camera.received.length).toBeGreaterThan(receivedBefore)
			})
			expect(camera.received[receivedBefore]).toEqual(PowerInquiryBytes)
			camera.answerAs(on)

			for (let passed = 0; passed < 3 * DefaultPollInterval; passed += 10) {
				await timePasses(10)
				expect(values(module)).toEqual(ValuesOn)
			}

			// The camera answered the probe, so the inquiry was taken to
			// be ignored, and its late answer found nothing pending.
			const [power, panTilt, ...lens] = on.replies.map(({ inquiry }) => inquiry)
			expect(camera.received.slice(receivedBefore, receivedBefore + InquiriesPerPass + 1)).toEqual([
				power,
				panTilt, // the probe
				panTilt,
				...lens,
			])
			expect(logged(module, 'debug')).toContainEqual('Ignoring unsolicited inquiry response [90 50 03 FF]')
			expect(noLongerPolled(module)).toEqual([])
			expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])
			expect(logged(module, 'warn', 'error')).toEqual([])
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})
})
