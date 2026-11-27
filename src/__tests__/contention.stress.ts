import { InstanceStatus } from '@companion-module/base'
import { describe, expect, test } from 'vitest'
import { PanTiltActionId } from '../actions/pan-tilt.js'
import { PresetActionId, PresetAsNumberId, PresetIsTextId } from '../actions/presets.js'
import { ZoomActionId } from '../actions/zoom.js'
import type { CameraPowerState } from '../camera/power.js'
import type { RawConfig } from '../config.js'
import { OverlapWaitLimitMs } from '../instance.js'
import { ModuleUnderTest } from './module-under-test.js'
import { PollGroupId } from '../status/groups.js'
import type { Bytes } from '../utils/byte.js'
import { prettyBytes } from '../utils/pretty.js'
import { PanTiltHomeBytes, PresetRecallBytes } from '../visca/__tests__/camera-interactions/bytes.js'
import { Cameras, HandWrittenCamera, PowerInquiryBytes } from '../visca/__tests__/simulator/cameras.js'
import { type CameraReplies, SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'

// T3, contention: an operator presses bursts of buttons while the module
// polls a camera that takes as long over each reply as a real one.
//
// The module holds a command back while a polled inquiry is unanswered, for
// no longer than `OverlapWaitLimitMs`.  That hold is the delay polling adds
// to a command, and this measures it.
//
// The clock is the real one, `performance.now()`, and no timer is faked: a
// millisecond here is a millisecond.  Everything is timed from outside the
// module, in this one process:
//
//  - pressed: just before the action is handed to the module, as Companion
//    hands it over when a button is pressed;
//  - sent: when the command's bytes reach the simulated camera;
//  - acknowledged: when the module logs that it has processed the command's
//    ACK, which it does with debug logging on.
//
// So "press to camera" includes the time the bytes take to cross a local
// socket, a fraction of a millisecond, and "press to acknowledgement"
// includes the camera's latency and the trip back.  The same bursts with
// polling off give what those cost with nothing held back; the delay polling
// adds is the rest.
//
// Every burst but those with polling off starts as a poll pass starts, with
// the pass's first inquiry unanswered, and goes on into the pass: the worst
// moments to press a button, not the usual ones.

/**
 * How long the simulated camera takes over each reply.  A real camera
 * acknowledged a command in about 10 ms and answered an inquiry in about
 * 11 ms (medians of 60, measured 2026-11-26).
 */
const CameraLatencyMs = 10

/**
 * How long a slow camera takes over each reply: longer than a command is
 * ever held back for.
 */
const SlowCameraLatencyMs = 1.5 * OverlapWaitLimitMs

/**
 * The most that polling may add, at the median, to a command pressed while a
 * camera that answers in about 10 ms has an inquiry unanswered.
 */
const TypicalAddedDelayLimitMs = 40

/**
 * How late the real clock may run the timer that ends a hold: a command held
 * for the whole of `OverlapWaitLimitMs` reaches the camera this much after
 * it at the latest.  Only the slow camera's commands are held that long.
 */
const TimerLatenessAllowedMs = 25

/** The interval between poll passes when the config doesn't give one. */
const DefaultPollInterval = 1000

/** The interval between poll passes for a while after a command. */
const FastPollInterval = 200

const BurstsWithPollingOff = 15
const BurstsAtNormalRate = 6
const BurstsAtFastRate = 15

/**
 * How long before each press of a burst the press before it came: the first
 * two as close together as Companion can hand two actions over, the rest a
 * few milliseconds apart.
 */
const GapsInBurstMs = [0, 0, 6, 6, 6, 6]

/** The pan/tilt speed the module starts with. */
const DefaultSpeed = 0x0c

type Press = {
	readonly actionId: string
	readonly options?: { readonly [id: string]: number | boolean }
	/** The bytes the camera must receive. */
	readonly bytes: Bytes
}

function recallPreset(preset: number): Press {
	return {
		actionId: PresetActionId.RecallPreset,
		options: { [PresetIsTextId]: false, [PresetAsNumberId]: preset },
		bytes: PresetRecallBytes(preset),
	}
}

/**
 * The buttons of one burst: a preset recalled, then the camera nudged, zoomed
 * and sent home.  Each burst recalls a different preset, so that no two
 * bursts send the same bytes.
 */
function burstPresses(burst: number): Press[] {
	return [
		recallPreset(burst),
		{
			actionId: PanTiltActionId.PanLeft,
			bytes: [0x81, 0x01, 0x06, 0x01, DefaultSpeed, DefaultSpeed, 0x01, 0x03, 0xff],
		},
		{
			actionId: PanTiltActionId.StopMoving,
			bytes: [0x81, 0x01, 0x06, 0x01, DefaultSpeed, DefaultSpeed, 0x03, 0x03, 0xff],
		},
		{ actionId: ZoomActionId.StartZoomIn, bytes: [0x81, 0x01, 0x04, 0x07, 0x02, 0xff] },
		{ actionId: ZoomActionId.StopZoom, bytes: [0x81, 0x01, 0x04, 0x07, 0x00, 0xff] },
		{ actionId: PanTiltActionId.ResetToHome, bytes: PanTiltHomeBytes },
	]
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms)
	})
}

/** Wait until the condition holds, looking about every millisecond. */
async function until(condition: () => boolean, limitMs = 10_000): Promise<void> {
	const start = performance.now()
	while (!condition()) {
		if (performance.now() - start > limitMs) {
			throw new Error(`Waited ${limitMs} ms in vain`)
		}
		await sleep(1)
	}
}

function isCommand(message: Bytes): boolean {
	return message[1] === 0x01
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** `median max` of the values, in milliseconds. */
function figures(values: readonly number[]): string {
	return values.length === 0
		? 'none'
		: `median ${median(values).toFixed(1)} ms, max ${Math.max(...values).toFixed(1)} ms`
}

/** What was measured of one command. */
type Timing = {
	/** From the press to the command reaching the camera. */
	readonly toCamera: number
	/** From the press to the module processing the command's acknowledgement. */
	readonly toAcknowledgement: number
	/** Whether the camera had an inquiry unanswered at the press. */
	readonly duringInquiry: boolean
}

/**
 * A module and a simulated camera, with every command pressed timed from the
 * press to the camera and to its acknowledgement.
 */
class TimedRig {
	readonly #latencyMs: number

	readonly camera: SimulatedCamera
	readonly module: ModuleUnderTest

	/** Every button pressed, oldest first, and when. */
	readonly #pressed: Press[] = []
	readonly #pressedAt: number[] = []
	readonly #executed: Promise<void>[] = []

	/** The lines the module logged as it processed each command's ACK, and when. */
	readonly acknowledgements: string[] = []
	readonly #acknowledgedAt: number[] = []

	/** How many commands the module logged the completion of. */
	completions = 0

	private constructor(camera: SimulatedCamera, module: ModuleUnderTest, latencyMs: number) {
		this.camera = camera
		this.module = module
		this.#latencyMs = latencyMs
		module.onLog = (message) => {
			if (message.includes(' ACK in socket ')) {
				this.acknowledgements.push(message)
				this.#acknowledgedAt.push(performance.now())
			} else if (message.startsWith('Completion in socket ')) {
				this.completions++
			}
		}
	}

	static async start(
		camera: { readonly power: CameraPowerState; readonly replies: CameraReplies; readonly latencyMs: number },
		config: Omit<RawConfig, 'host' | 'port' | 'debugLogging'>,
	): Promise<TimedRig> {
		const simulated = await SimulatedCamera.start(camera)
		// Every setting but these and the ones given takes its default.  Debug
		// logging is on because that's how the module says when it processes
		// an acknowledgement.
		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(simulated.port),
			debugLogging: true,
			...config,
		})
		return new TimedRig(simulated, module, camera.latencyMs)
	}

	async stop(): Promise<void> {
		await this.module.destroy()
		await this.camera.stop()
	}

	/** Press a button, without waiting for anything to come of it. */
	press(press: Press): void {
		this.#pressed.push(press)
		this.#pressedAt.push(performance.now())
		this.#executed.push(this.module.executeAction(press.actionId, press.options))
	}

	/**
	 * Press the buttons of a burst, with the gaps of a burst between them.
	 *
	 * Companion hands each action over in a message of its own, so even two
	 * with no gap between them are a turn of the event loop apart.
	 */
	async burst(burst: number): Promise<void> {
		for (const [i, press] of burstPresses(burst).entries()) {
			if (GapsInBurstMs[i] > 0) {
				await sleep(GapsInBurstMs[i])
			} else if (i > 0) {
				await new Promise((resolve) => {
					setImmediate(resolve)
				})
			}
			this.press(press)
		}
	}

	/** How many buttons have been pressed. */
	get pressed(): number {
		return this.#pressed.length
	}

	/** The bytes of every command pressed, oldest first. */
	get bytesPressed(): Bytes[] {
		return this.#pressed.map(({ bytes }) => bytes)
	}

	/** The commands the camera has received, oldest first. */
	get commandsReceived(): Bytes[] {
		return this.camera.received.filter(isCommand)
	}

	/** Wait until every command pressed has been acknowledged and completed, or can't be. */
	async settled(): Promise<void> {
		await Promise.all(this.#executed)
		await until(() => this.completions >= this.#pressed.length || this.errorsLogged.length > 0, 5000).catch(() => {})
	}

	/** When each poll pass started: when its first inquiry, for power, reached the camera. */
	get passStarts(): number[] {
		const { received, receivedAt } = this.camera
		return receivedAt.filter((_, i) => String(received[i]) === String(PowerInquiryBytes))
	}

	/**
	 * Wait for a poll pass to start that comes after the given kind of gap
	 * since the pass before it started.
	 */
	async passStartsAfterGap(gapIsRight: (gapMs: number) => boolean): Promise<void> {
		for (;;) {
			const before = this.passStarts.length
			await until(() => this.passStarts.length > before)
			const [previous, latest] = this.passStarts.slice(-2)
			if (latest !== undefined && gapIsRight(latest - previous)) {
				return
			}
		}
	}

	/**
	 * What was measured of the commands pressed from the given one on.  Call
	 * only once every command has reached the camera, in order, and been
	 * acknowledged.
	 */
	timings(from: number): Timing[] {
		const { received, receivedAt } = this.camera
		const commandsAt = receivedAt.filter((_, i) => isCommand(received[i]))
		const inquiriesAt = receivedAt.filter((_, i) => !isCommand(received[i]))
		return this.#pressedAt.slice(from).map((pressedAt, i) => ({
			toCamera: commandsAt[from + i] - pressedAt,
			toAcknowledgement: this.#acknowledgedAt[from + i] - pressedAt,
			duringInquiry: inquiriesAt.some((at) => at <= pressedAt && pressedAt < at + this.#latencyMs),
		}))
	}

	get errorsLogged(): string[] {
		return this.module.logs.filter(({ level }) => level === 'error').map(({ message }) => message)
	}

	/** Expect every command pressed to have been sent and acknowledged, in the order pressed, and none to have failed. */
	expectEveryCommandSucceeded(): void {
		expect(this.errorsLogged).toEqual([])
		expect(this.commandsReceived).toEqual(this.bytesPressed)
		expect(this.acknowledgements).toEqual(
			this.bytesPressed.map((bytes) => `Processing ${prettyBytes(bytes)} ACK in socket 1`),
		)
		expect(this.completions).toBe(this.pressed)
		expect(this.module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])
	}
}

function report(title: string, timings: readonly Timing[]): string {
	const held = timings.filter(({ duringInquiry }) => duringInquiry)
	return (
		`  ${title}: ${timings.length} commands, ${held.length} pressed while an inquiry was unanswered\n` +
		`    press to camera:          ${figures(timings.map(({ toCamera }) => toCamera))}\n` +
		`      while an inquiry was unanswered: ${figures(held.map(({ toCamera }) => toCamera))}\n` +
		`    press to acknowledgement: ${figures(timings.map(({ toAcknowledgement }) => toAcknowledgement))}\n` +
		`      while an inquiry was unanswered: ${figures(held.map(({ toAcknowledgement }) => toAcknowledgement))}`
	)
}

describe.each(Cameras)('bursts of commands during polling: $name', ({ replies: { on, standby } }) => {
	// How a camera wakes is for other scenarios.
	const camera = { power: 'on', replies: { on, standby }, latencyMs: CameraLatencyMs } as const

	test('every command is sent and acknowledged in order, and polling delays none for long', async () => {
		// The baseline: the same bursts with polling off.
		let off: Timing[]
		{
			const rig = await TimedRig.start(camera, { pollEnabled: false })
			try {
				await until(() => rig.module.status === InstanceStatus.Ok)
				for (let burst = 1; burst <= BurstsWithPollingOff; burst++) {
					await rig.burst(burst)
					await rig.settled()
				}

				rig.expectEveryCommandSucceeded()
				expect(rig.camera.received).toEqual(rig.bytesPressed)
				off = rig.timings(0)
			} finally {
				await rig.stop()
			}
		}

		let normal: Timing[]
		let fast: Timing[]
		const rig = await TimedRig.start(camera, { pollEnabled: true })
		try {
			// At the normal rate: each burst starts with a pass that the
			// module left the whole poll interval before.  A command speeds
			// polling up for a while, so that takes a wait.
			let burst = 0
			while (burst < BurstsAtNormalRate) {
				await rig.passStartsAfterGap((gapMs) => gapMs >= 0.9 * DefaultPollInterval)
				await rig.burst(++burst)
				await rig.settled()
			}
			rig.expectEveryCommandSucceeded()
			normal = rig.timings(0)

			// At the fast rate: a burst with every pass, one soon after
			// another, while the commands keep polling fast.
			const pressedAtNormalRate = rig.pressed
			while (burst < BurstsAtNormalRate + BurstsAtFastRate) {
				await rig.passStartsAfterGap((gapMs) => gapMs < 3 * FastPollInterval)
				await rig.burst(++burst)
				await rig.settled()
			}
			rig.expectEveryCommandSucceeded()
			fast = rig.timings(pressedAtNormalRate)

			// Polling goes on, answered.
			const passes = rig.passStarts.length
			await until(() => rig.passStarts.length >= passes + 2)
			expect(rig.module.variable('power')).toBe('on')
			expect(rig.module.logs.filter(({ level }) => level === 'warn')).toEqual([])
		} finally {
			await rig.stop()
		}

		const baseline = median(off.map(({ toCamera }) => toCamera))
		console.log(
			`T3, camera taking ${CameraLatencyMs} ms over each reply, real time:\n` +
				`${report('polling off', off)}\n` +
				`${report(`polling at the normal rate (${DefaultPollInterval} ms)`, normal)}\n` +
				`${report(`polling at the fast rate (${FastPollInterval} ms)`, fast)}\n` +
				`  delay polling adds (press to camera, less its median with polling off, ${baseline.toFixed(1)} ms),` +
				` to commands pressed while an inquiry was unanswered:\n` +
				[['normal rate', normal] as const, ['fast rate', fast] as const]
					.map(([rate, timings]) => {
						const added = timings
							.filter(({ duringInquiry }) => duringInquiry)
							.map(({ toCamera }) => toCamera - baseline)
						return `    ${rate}: ${figures(added)}`
					})
					.join('\n'),
		)

		for (const timings of [normal, fast]) {
			// The bursts did contend with polling.
			const held = timings.filter(({ duringInquiry }) => duringInquiry).map(({ toCamera }) => toCamera)
			expect(held.length).toBeGreaterThanOrEqual(timings.length / 3)

			// The whole time from press to camera is held to the limits, so
			// the part of it that polling adds is within them too.
			expect(Math.max(...timings.map(({ toCamera }) => toCamera))).toBeLessThanOrEqual(OverlapWaitLimitMs)
			expect(median(held)).toBeLessThanOrEqual(TypicalAddedDelayLimitMs)
		}
	})

	test('camera slower than a command is ever held back for: the command is sent by the limit and succeeds', async () => {
		const rig = await TimedRig.start({ ...camera, latencyMs: SlowCameraLatencyMs }, { pollEnabled: true })
		try {
			// Each command is pressed as a poll pass starts, so it is held
			// back for an inquiry that isn't answered in time.
			for (let preset = 1; preset <= 5; preset++) {
				await rig.passStartsAfterGap(() => true)
				rig.press(recallPreset(preset))
				await rig.settled()
			}

			rig.expectEveryCommandSucceeded()
			const timings = rig.timings(0)
			console.log(
				`T3, camera taking ${SlowCameraLatencyMs} ms over each reply, real time:\n` +
					report('command pressed as a poll pass starts', timings),
			)
			expect(timings.every(({ duringInquiry }) => duringInquiry)).toBe(true)
			expect(Math.max(...timings.map(({ toCamera }) => toCamera))).toBeLessThanOrEqual(
				OverlapWaitLimitMs + TimerLatenessAllowedMs,
			)

			const passes = rig.passStarts.length
			await until(() => rig.passStarts.length >= passes + 2)
			expect(rig.module.variable('power')).toBe('on')
		} finally {
			await rig.stop()
		}
	})
})

describe('camera slower than a command is ever held back for refuses a polled inquiry', () => {
	/**
	 * Press one button as an inquiry that the camera will refuse reaches it,
	 * and wait for whatever comes of that.
	 *
	 * Poll without the power group, so that the camera, in standby, refuses
	 * an inquiry in every pass: see `refusal-overlapping-command.test.ts`.
	 */
	async function commandPressedWhileRefusedInquiryUnanswered(): Promise<TimedRig> {
		const rig = await TimedRig.start(
			{ power: 'standby', replies: HandWrittenCamera.replies, latencyMs: SlowCameraLatencyMs },
			{ pollEnabled: true, pollGroups: [PollGroupId.Position] },
		)
		try {
			// Let the camera refuse an inquiry first.
			await until(() => rig.camera.received.length >= 2)

			const received = rig.camera.received.length
			await until(() => rig.camera.received.length > received)
			rig.press(recallPreset(1))
			await rig.settled()
			// The refusal and the acknowledgement are both in by now.
			await sleep(2 * SlowCameraLatencyMs)
			return rig
		} finally {
			await rig.stop()
		}
	}

	test('command pressed while the refused inquiry is unanswered: the command is sent by the limit', async () => {
		const rig = await commandPressedWhileRefusedInquiryUnanswered()

		expect(rig.commandsReceived).toEqual(rig.bytesPressed)
		const [{ toCamera }] = rig.timings(0)
		console.log(
			`T3, camera taking ${SlowCameraLatencyMs} ms to refuse an inquiry, real time: the command reached the ` +
				`camera ${toCamera.toFixed(1)} ms after the press`,
		)
		expect(toCamera).toBeLessThanOrEqual(OverlapWaitLimitMs + TimerLatenessAllowedMs)
	})

	// KNOWN LIMIT, and the reason this is `test.fails`: the overlap that
	// holding a command back prevents happens after all when the camera takes
	// longer over the refusal than `OverlapWaitLimitMs`.  The command is sent
	// at the limit with the inquiry still unanswered, and then:
	//
	//  1. the refusal of the inquiry (`90 61 41 FF`) arrives and the port
	//     credits it to the command, so the module logs "Error processing
	//     command: The command [81 01 04 3F 02 01 FF] can't be executed
	//     now...", though the camera received and acknowledged the command;
	//  2. the command's ACK arrives with no command left awaiting one, so the
	//     module logs "Received ACK without a pending command (VISCA bytes
	//     [90 41 FF])", reports connection failure, and closes the
	//     connection, which stays closed until the user disables and enables
	//     the connection.
	//
	// When the module survives this the test will fail for passing: make it a
	// plain `test` then.
	test.fails('command pressed while the refused inquiry is unanswered: the command succeeds', async () => {
		const rig = await commandPressedWhileRefusedInquiryUnanswered()

		console.log(
			`T3, camera taking ${SlowCameraLatencyMs} ms to refuse an inquiry: errors logged: ` +
				`${JSON.stringify(rig.errorsLogged)}; statuses: ${JSON.stringify(rig.module.statuses)}`,
		)
		rig.expectEveryCommandSucceeded()
	})
})
