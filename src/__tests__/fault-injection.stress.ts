import { InstanceStatus } from '@companion-module/base'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import type { CameraPowerState } from '../camera/power.js'
import { describeEachCamera } from './each-camera.js'
import { eventually, fakedTimeWaitsForSockets, timePasses } from './faked-time.js'
import { ModuleUnderTest } from './module-under-test.js'
import { CameraPowerBytes, CommandNotExecutable } from '../visca/__tests__/camera-interactions/bytes.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'

// T2, fault injection: the module polls a camera that misbehaves again and
// again, in a pseudo-random order decided by a seed, over hours of faked time.
//
// The faults are the ones a real camera or network produces and the module is
// meant to survive:
//
//  - the connection drops;
//  - the connection drops and attempts to connect are refused for a while;
//  - the camera goes silent for a while without closing the connection;
//  - the camera stalls, for less time than the module waits for an answer;
//  - one reply comes late, or later than the module waits for an answer;
//  - the camera refuses one message (`90 61 41 FF`);
//  - the camera answers one inquiry with the answer to some other inquiry.
//
// One fault is left out on purpose: bytes that aren't a VISCA return message.
// When a camera sends those the module closes the connection and leaves it
// closed until the user disables and enables it, so as not to repeat forever
// whatever provoked them.  That is the intended behavior, and it never
// "returns to ok" unaided.  `late-or-garbled-reply.test.ts` covers it.
//
// THE SEED IS RANDOM ON EVERY RUN unless `STRESS_SEED` is set: two runs
// without it inject different faults, so a pass says only that this run's
// faults were survived.  The seed is logged, named in each test's title, and
// repeated in any failure, so that
//
//     STRESS_SEED=<seed> yarn test:stress
//
// runs the same faults again.
//
// What the seed fixes: which fault is injected at each of the `FaultCount`
// steps, how long it lasts, and how long the camera behaves before it.  The
// same seed always gives the same list, in the same order.
//
// What the seed doesn't fix: where a fault lands in the module's polling.
// The sockets are real, so the inquiry a fault catches, or whether it falls
// between two passes, can differ from run to run of the same seed.  A failure
// that depends on that may not come back when its seed is run again.
//
// The pass rule, exactly as coded below.  For every camera:
//
//  1. To begin, the power variable reads on, and the statuses reported are
//     Connecting then Ok.
//  2. Before each fault, while the camera behaves (500 ms to 5 s), no status
//     is reported.
//  3. After a fault that leaves the camera unreachable or silent (the
//     connection drops, with or without attempts to connect then being
//     refused; the camera goes silent; a reply comes later than the module
//     waits): from `NoticeMs` after the fault is over, the status becomes Ok
//     within `RecoveryLimit`, with no Connection Failure reported on the way.
//     Whatever was reported before that isn't checked.
//  4. After any other fault (the camera stalls; a reply comes late, but in
//     time; the camera refuses a message; an inquiry gets some other
//     inquiry's answer): for a poll interval more, no status is reported.
//  5. After every fault, a power command sent through the module changes
//     the camera's power state, and the power variable follows, within
//     `VariableLimit`, and no status is reported meanwhile.
//  6. At the end, the statuses reported over the whole run are exactly
//     Connecting, Ok and Connection Failure, each at least once; a last
//     Power On reaches the camera; and the status is Ok.
//
// Nothing else is checked: not what was logged, not any variable but power,
// and not whether an inquiry stopped being polled.

/** How many faults are injected, one after another, into each camera. */
const FaultCount = 1500

/** The interval between poll passes when the config doesn't give one. */
const DefaultPollInterval = 1000

/** How long the module gives the camera to answer a polled inquiry. */
const InquiryTimeout = 3000

/** How long the module's socket waits after a failed attempt to connect before trying again. */
const ReconnectInterval = 2000

/**
 * How long after a fault is over the module may still report the failure it
 * caused: long enough for the module to find a dropped connection closed.
 */
const NoticeMs = 500

/**
 * The longest the module may take to report ok once the camera is reachable
 * and answering again: one more attempt to connect, or one more wait for an
 * answer.
 */
const RecoveryLimit = ReconnectInterval + InquiryTimeout

/** The longest a variable may take to follow the camera: a few poll passes. */
const VariableLimit = 5 * DefaultPollInterval

/** A well-formed answer to an inquiry, but to none that the module polls. */
const AnswerToSomethingElse = [0x90, 0x50, 0x7f, 0x7f, 0x7f, 0xff]

/** Something the camera or the network does wrong. */
type Fault =
	| { readonly does: 'drops-connection' }
	| { readonly does: 'unreachable'; readonly ms: number }
	| { readonly does: 'silent'; readonly ms: number }
	| { readonly does: 'stalls'; readonly ms: number }
	| { readonly does: 'replies-late'; readonly ms: number }
	| { readonly does: 'replies-too-late'; readonly ms: number }
	| { readonly does: 'refuses' }
	| { readonly does: 'answers-something-else' }

type PlannedFault = {
	/** How long the camera behaves before the fault. */
	readonly afterMs: number
	readonly fault: Fault
}

function seed(): number {
	const fromEnvironment = process.env.STRESS_SEED
	if (fromEnvironment === undefined || fromEnvironment === '') {
		return Math.floor(Math.random() * 2 ** 32)
	}

	const seed = Number(fromEnvironment)
	if (!Number.isInteger(seed) || seed < 0 || seed >= 2 ** 32) {
		throw new Error(`STRESS_SEED must be an integer from 0 to ${2 ** 32 - 1}, not ${JSON.stringify(fromEnvironment)}`)
	}
	return seed
}

/** A source of numbers in [0, 1) that are the same every time for the same seed (mulberry32). */
function randomNumbers(seed: number): () => number {
	let state = seed
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let n = state
		n = Math.imul(n ^ (n >>> 15), n | 1)
		n ^= n + Math.imul(n ^ (n >>> 7), n | 61)
		return ((n ^ (n >>> 14)) >>> 0) / 2 ** 32
	}
}

/** The faults to inject for the given seed, in order. */
function plannedFaults(seed: number, count: number): PlannedFault[] {
	const random = randomNumbers(seed)
	const between = (min: number, max: number) => min + Math.floor(random() * (max - min))

	const faults: (() => Fault)[] = [
		() => ({ does: 'drops-connection' }),
		() => ({ does: 'unreachable', ms: between(100, 10_000) }),
		() => ({ does: 'silent', ms: between(InquiryTimeout + 500, 15_000) }),
		() => ({ does: 'stalls', ms: between(100, InquiryTimeout - 1000) }),
		() => ({ does: 'replies-late', ms: between(100, InquiryTimeout - 1000) }),
		() => ({ does: 'replies-too-late', ms: between(InquiryTimeout + 500, 8000) }),
		() => ({ does: 'refuses' }),
		() => ({ does: 'answers-something-else' }),
	]

	return Array.from({ length: count }, () => {
		const afterMs = between(500, 5000)
		const fault = faults[between(0, faults.length)]()
		return { afterMs, fault }
	})
}

const Seed = seed()
console.log(`Fault injection seed: ${Seed}.  To run these faults again: STRESS_SEED=${Seed} yarn test:stress`)

test('a seed always gives the same faults, so a failed run can be run again', () => {
	// Change how faults are planned and this fails: seeds logged by earlier
	// runs then no longer mean what they did.
	expect(plannedFaults(2026, 6)).toEqual([
		{ afterMs: 2549, fault: { does: 'silent', ms: 11103 } },
		{ afterMs: 3283, fault: { does: 'unreachable', ms: 2296 } },
		{ afterMs: 3572, fault: { does: 'refuses' } },
		{ afterMs: 1820, fault: { does: 'drops-connection' } },
		{ afterMs: 799, fault: { does: 'replies-late', ms: 838 } },
		{ afterMs: 1015, fault: { does: 'unreachable', ms: 3377 } },
	])

	expect(plannedFaults(Seed, FaultCount)).toEqual(plannedFaults(Seed, FaultCount))
	expect(plannedFaults(Seed + 1, FaultCount)).not.toEqual(plannedFaults(Seed, FaultCount))
})

describeEachCamera(
	`${FaultCount} faults, one after another, from seed ${Seed}`,
	['on', 'standby'],
	({ replies: { on, standby } }) => {
		// How a camera wakes is for other scenarios: this one is on as soon as
		// it's told to be.
		const replies = { on, standby }

		// Fake the timers and the clock, not the sockets, so that neither the
		// faults nor the waits between them take real time.  `timePasses` and
		// `eventually` let faked time go by, no faster than the sockets can
		// keep up with over so long a run.
		let socketsNoLongerWaitedFor: () => Promise<void>
		beforeEach(async () => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
			socketsNoLongerWaitedFor = await fakedTimeWaitsForSockets()
		})
		afterEach(async () => {
			await socketsNoLongerWaitedFor()
			vi.useRealTimers()
		})

		test('the connection fails only while the camera is unreachable or silent, is ok again unaided every time, values update again, and a Power On at the end reaches the camera', async () => {
			const camera = await SimulatedCamera.start({ power: 'on', replies })

			// Every setting but these takes its default.
			const module = await ModuleUnderTest.start({
				host: '127.0.0.1',
				port: String(camera.port),
				pollEnabled: true,
			})

			/** Wait for the camera to receive a message, which it then does wrong by. */
			const messageReceived = async () => {
				const receivedBefore = camera.received.length
				await eventually(() => {
					expect(camera.received.length).toBeGreaterThan(receivedBefore)
				})
			}

			/**
			 * Tell the camera to change power state through the module, and
			 * wait for the module's variable to follow.
			 */
			const power = async (state: CameraPowerState) => {
				await module.executeAction(PowerActionId.CameraPowerState, { bool: state === 'on' ? 'on' : 'off' })
				await eventually(() => {
					expect(camera.power).toBe(state)
					expect(module.variable('power')).toBe(state)
				}, VariableLimit)
			}

			/**
			 * Do the fault, and let it run its course.
			 *
			 * @returns
			 *    Whether the fault made the camera unreachable or silent, so
			 *    that the connection may have failed.
			 */
			const inject = async (fault: Fault): Promise<boolean> => {
				switch (fault.does) {
					case 'drops-connection':
						camera.dropConnection()
						return true
					case 'unreachable':
						camera.refuseConnections()
						camera.dropConnection()
						await timePasses(fault.ms)
						await camera.acceptConnections()
						return true
					case 'silent':
						camera.stall(fault.ms)
						await timePasses(fault.ms)
						return true
					case 'replies-too-late':
						camera.replyLate(fault.ms)
						await messageReceived()
						await timePasses(InquiryTimeout)
						return true
					case 'stalls':
						camera.stall(fault.ms)
						await timePasses(fault.ms)
						return false
					case 'replies-late':
						camera.replyLate(fault.ms)
						await messageReceived()
						await timePasses(fault.ms)
						return false
					case 'refuses':
						camera.replyGarbled(CommandNotExecutable(1))
						await messageReceived()
						return false
					case 'answers-something-else':
						camera.replyGarbled(AnswerToSomethingElse)
						await messageReceived()
						return false
				}
			}

			const started = Date.now()
			try {
				await eventually(() => {
					expect(module.variable('power')).toBe('on')
				})
				expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])

				/** How many statuses the module had reported when the connection was last seen to be ok. */
				let statusesWhenOk = module.statuses.length

				for (const [index, { afterMs, fault }] of plannedFaults(Seed, FaultCount).entries()) {
					try {
						// While the camera behaves, the status doesn't change.
						await timePasses(afterMs)
						expect(module.statuses.length).toBe(statusesWhenOk)

						const unreachableOrSilent = await inject(fault)
						if (unreachableOrSilent) {
							// The connection may have failed meanwhile.  Now
							// that the camera is back it mustn't fail again,
							// and must come to be ok.
							await timePasses(NoticeMs)
							const statusesWhenBack = module.statuses.length
							await eventually(() => {
								expect(module.status).toBe(InstanceStatus.Ok)
							}, RecoveryLimit)
							expect(module.statuses.slice(statusesWhenBack)).not.toContain(InstanceStatus.ConnectionFailure)
							statusesWhenOk = module.statuses.length
						} else {
							// Nothing the module can't take in its stride.
							await timePasses(DefaultPollInterval)
							expect(module.statuses.length).toBe(statusesWhenOk)
						}

						// Commands reach the camera and values update again.
						await power(camera.power === 'on' ? 'standby' : 'on')
						expect(module.statuses.length).toBe(statusesWhenOk)
					} catch (e) {
						throw new Error(
							`Fault ${index + 1} of ${FaultCount} (${JSON.stringify(fault)}) from seed ${Seed}: ` +
								`run it again with STRESS_SEED=${Seed}`,
							{ cause: e },
						)
					}
				}

				expect(new Set(module.statuses)).toEqual(
					new Set([InstanceStatus.Connecting, InstanceStatus.Ok, InstanceStatus.ConnectionFailure]),
				)

				if (camera.power === 'on') {
					await power('standby')
				}
				const receivedBefore = camera.received.length
				await power('on')
				expect(camera.received.slice(receivedBefore)).toContainEqual(CameraPowerBytes)
				expect(module.status).toBe(InstanceStatus.Ok)

				const minutes = Math.round((Date.now() - started) / 60_000)
				console.log(`Seed ${Seed}: ${FaultCount} faults injected over ${minutes} minutes of faked time`)
			} finally {
				await module.destroy()
				await camera.stop()
			}
		})
	},
)
