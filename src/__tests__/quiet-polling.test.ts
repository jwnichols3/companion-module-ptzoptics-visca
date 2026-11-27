import { InstanceStatus } from '@companion-module/base'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import { describeEachCamera, stateInWords } from './each-camera.js'
import { eventually } from './faked-time.js'
import { ModuleUnderTest } from './module-under-test.js'
import { PollGroupId } from '../status/groups.js'
import { CameraPowerBytes } from '../visca/__tests__/camera-interactions/bytes.js'
import { inquiriesIgnored, PowerInquiryBytes } from '../visca/__tests__/simulator/cameras.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'

/** How many poll passes the module must get through. */
const PollPasses = 60

/** Longer than sixty poll passes take, even if every inquiry in every pass is slow to be answered. */
const LongEnough = 10 * 60 * 1000

for (const power of ['on', 'standby'] as const) {
	describeEachCamera(
		`sixty poll passes of every status group, camera ${stateInWords(power)}`,
		[power],
		({ replies }) => {
			// Fake only the timers, not the sockets, so that the waits between poll
			// passes take no real time.  `eventually` lets faked time go by while it
			// waits.
			beforeEach(() => {
				vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
			})
			afterEach(() => {
				vi.useRealTimers()
			})

			// The module takes the connection for lost each time an inquiry goes
			// unanswered, until it gives the inquiry up, so polling a camera that
			// ignores inquiries isn't quiet from the start.  What it costs, and
			// that polling is quiet afterwards, is for another scenario.
			const ignored = power === 'on' ? inquiriesIgnored(replies[power]) : 0
			if (ignored > 0) {
				test.skip(`not run: the camera ignores ${ignored} inquiries (see camera-ignores-inquiries.test.ts)`, () => {})
				return
			}

			// A camera in standby is told to power on, which one never recorded
			// on can't be.
			const powersOn = replies.on !== undefined
			if (!powersOn) {
				test.skip("Power On reaches the camera: not run, the camera wasn't recorded on", () => {})
			}

			test(`the connection status never changes${powersOn ? ', no log line is repeated, and Power On reaches the camera' : ' and no log line is repeated'}`, async () => {
				const camera = await SimulatedCamera.start({ power, replies })

				const module = await ModuleUnderTest.start({
					host: '127.0.0.1',
					port: String(camera.port),
					pollEnabled: true,
					pollInterval: 100,
					pollGroups: Object.values(PollGroupId),
				})
				try {
					// Every pass starts with the power inquiry, so one more of
					// them than passes wanted means that many passes are done.
					await eventually(() => {
						const passesStarted = camera.received.filter(
							(message) => String(message) === String(PowerInquiryBytes),
						).length
						expect(passesStarted).toBeGreaterThan(PollPasses)
					}, LongEnough)

					expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])
					expect(module.variable('power')).toBe(power)

					const lines = module.logs.map(({ level, message }) => `${level}: ${message}`)
					expect(lines).toEqual([...new Set(lines)])

					if (powersOn) {
						await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
						await eventually(() => {
							expect(camera.received).toContainEqual(CameraPowerBytes)
						})
						expect(camera.power).toBe('on')
					}
				} finally {
					await module.destroy()
					await camera.stop()
				}
			})
		},
	)
}
