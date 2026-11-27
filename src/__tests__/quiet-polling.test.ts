import { InstanceStatus } from '@companion-module/base'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import { eventually } from './faked-time.js'
import { ModuleUnderTest } from './module-under-test.js'
import { PollGroupId } from '../status/groups.js'
import { CameraPowerBytes } from '../visca/__tests__/camera-interactions/bytes.js'
import { Cameras, PowerInquiryBytes } from '../visca/__tests__/simulator/cameras.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'

/** How many poll passes the module must get through. */
const PollPasses = 60

/** Longer than sixty poll passes take, even if every inquiry in every pass is slow to be answered. */
const LongEnough = 10 * 60 * 1000

describe.each(Cameras)('sixty poll passes of every status group: $name', ({ replies }) => {
	// Fake only the timers, not the sockets, so that the waits between poll
	// passes take no real time.  `eventually` lets faked time go by while it
	// waits.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	test.each(['on', 'standby'] as const)(
		'camera %s: the connection status never changes, no log line is repeated, and Power On reaches the camera',
		async (power) => {
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

				await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
				await eventually(() => {
					expect(camera.received).toContainEqual(CameraPowerBytes)
				})
				expect(camera.power).toBe('on')
			} finally {
				await module.destroy()
				await camera.stop()
			}
		},
	)
})
