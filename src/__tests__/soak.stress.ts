import { InstanceStatus } from '@companion-module/base'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import { describeEachCamera, stateInWords } from './each-camera.js'
import { eventually, fakedTimeWaitsForSockets, timePasses } from './faked-time.js'
import { ModuleUnderTest } from './module-under-test.js'
import { CameraPowerBytes } from '../visca/__tests__/camera-interactions/bytes.js'
import { PowerInquiryBytes } from '../visca/__tests__/simulator/cameras.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'

// T1, the soak: the module polls a camera that never misbehaves, at the
// default interval, for hours of faked time.
//
// What's measured, all of it from outside the module:
//
//  - The connection status the module reports.
//  - What the camera receives.  The status poller sends an inquiry only once
//    the one before it is answered, so messages piling up unanswered inside
//    the module would show as poll passes slowing down or stopping, and as a
//    command sent after the soak not reaching the camera.  The module's own
//    queues aren't looked into.
//  - The timers pending on the faked clock.
//  - The memory in use after a forced garbage collection.  That is the memory
//    of the whole test process: the module, the simulated camera and the test
//    runner together.

/** How long the module polls for, in faked time. */
const SoakMs = 8 * 60 * 60 * 1000

/**
 * How much faked time goes by between chances for the sockets to do their
 * work.  Larger than the step scenarios take, to fit the soak into the time a
 * test run can be given, so an answer seems to take the camera a few tens of
 * milliseconds, much as it takes a real camera.
 */
const StepMs = 25

/** The soak is measured at the end of each of this many equal spans. */
const Spans = 16
const SpanMs = SoakMs / Spans

/** The interval between poll passes when the config doesn't give one. */
const DefaultPollInterval = 1000

/**
 * The fewest poll passes a span must hold: one for every two default
 * intervals, which allows each pass to take as long again as the interval
 * that follows it.
 */
const FewestPassesPerSpan = SpanMs / (2 * DefaultPollInterval)

/**
 * The most memory in use may grow over the second half of the soak, after
 * forced garbage collection, without being taken for growth without bound.
 * Spread over the passes of that half this is under a hundred bytes a pass:
 * an object kept for every pass, or every inquiry, would exceed it.
 */
const MemoryGrowthAllowed = 1024 * 1024

function collectGarbage(): void {
	if (globalThis.gc === undefined) {
		throw new Error('Memory can only be measured if Node is run with --expose-gc: use `yarn test:stress`')
	}
	globalThis.gc()
}

// A camera on is only ever on.  One in standby is told to power on at the
// end, so it must have been recorded on too.
const Soaks = [
	{ power: 'on', states: ['on'] },
	{ power: 'standby', states: ['on', 'standby'] },
] as const

for (const { power, states } of Soaks) {
	describeEachCamera(
		`eight hours of polling at the default interval, camera ${stateInWords(power)}`,
		states,
		({ replies: { on, standby } }) => {
			// How a camera wakes is for other scenarios: this one is on as soon as
			// it's told to be.
			const replies = { on, standby }

			// Fake only the timers, not the sockets, so that the waits between poll
			// passes take no real time.  `timePasses` lets faked time go by, no faster
			// than the sockets can keep up with over so long a run.
			let socketsNoLongerWaitedFor: () => Promise<void>
			beforeEach(async () => {
				vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
				socketsNoLongerWaitedFor = await fakedTimeWaitsForSockets()
			})
			afterEach(async () => {
				await socketsNoLongerWaitedFor()
				vi.useRealTimers()
			})

			test('the connection status never changes, polling never slows, and neither timers nor memory pile up', async () => {
				const camera = await SimulatedCamera.start({ power, replies })

				// Every setting but these takes its default.
				const module = await ModuleUnderTest.start({
					host: '127.0.0.1',
					port: String(camera.port),
					pollEnabled: true,
				})
				try {
					const passes: number[] = []
					const messagesPerPass: number[] = []
					const timers: number[] = []
					const memory: number[] = []

					for (let span = 0; span < Spans; span++) {
						await timePasses(SpanMs, StepMs)

						// Every pass starts with the power inquiry.
						const passesStarted = camera.received.filter(
							(message) => String(message) === String(PowerInquiryBytes),
						).length
						passes.push(passesStarted)
						messagesPerPass.push(Math.round(camera.received.length / passesStarted))
						// Don't let the record of what the camera received pass for
						// memory the module holds on to.
						camera.received.length = 0

						timers.push(vi.getTimerCount())

						collectGarbage()
						memory.push(process.memoryUsage().heapUsed)
					}

					expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])
					expect(module.variable('power')).toBe(power)

					// Polling went on at the same rate throughout, asking the same
					// things: nothing was given up on, and nothing waited on.
					expect(Math.min(...passes)).toBeGreaterThanOrEqual(FewestPassesPerSpan)
					expect(Math.min(...passes)).toBeGreaterThan(0.9 * Math.max(...passes))
					expect(new Set(messagesPerPass).size).toBe(1)

					// The only timer pending is the wait for the next pass, or the
					// time limit on an inquiry.
					expect(Math.max(...timers)).toBe(1)

					const megabytes = memory.map((bytes) => (bytes / 1024 / 1024).toFixed(2)).join(', ')
					expect(
						memory[Spans - 1] - memory[Spans / 2 - 1],
						`memory in use grew over the second half of the soak (MB after each span: ${megabytes})`,
					).toBeLessThan(MemoryGrowthAllowed)

					const lines = module.logs.map(({ level, message }) => `${level}: ${message}`)
					expect(lines).toEqual([...new Set(lines)])

					// A command isn't stuck behind anything.
					await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
					await eventually(() => {
						expect(camera.received).toContainEqual(CameraPowerBytes)
					})
					await eventually(() => {
						expect(module.variable('power')).toBe('on')
					})
					expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])

					const hours = SoakMs / 60 / 60 / 1000
					const passesInAll = passes.reduce((sum, n) => sum + n, 0)
					console.log(
						`Camera ${power}: ${passesInAll} poll passes in ${hours} hours of faked time; ` +
							`MB in use after each of ${Spans} spans: ${megabytes}`,
					)
				} finally {
					await module.destroy()
					await camera.stop()
				}
			})
		},
	)
}
