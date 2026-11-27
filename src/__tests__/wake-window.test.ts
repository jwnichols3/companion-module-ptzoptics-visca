import { InstanceStatus, type LogLevel } from '@companion-module/base'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PowerActionId } from '../actions/power.js'
import { GenericVisca } from '../cameras/index.js'
import { eventually, timePasses } from './faked-time.js'
import { ModuleUnderTest } from './module-under-test.js'
import { CameraPowerBytes } from '../visca/__tests__/camera-interactions/bytes.js'
import { HandWrittenCamera } from '../visca/__tests__/simulator/cameras.js'
import { SimulatedCamera } from '../visca/__tests__/simulator/simulated-camera.js'

const CameraStandbyBytes = [0x81, 0x01, 0x04, 0x00, 0x03, 0xff]

/**
 * Longer than the module needs to find that a camera it had found silent as
 * it woke is answering again: a wait for an answer, then a new connection.
 */
const Recovery = 10_000

function logged(module: ModuleUnderTest, ...levels: LogLevel[]): string[] {
	return module.logs.filter(({ level }) => levels.includes(level)).map(({ message }) => message)
}

function saidWaking(module: ModuleUnderTest): string[] {
	return logged(module, 'info').filter((message) => message.startsWith('Camera is waking'))
}

// NOT CAPTURES: no camera has been recorded doing these.  They stand for a
// camera that's told to power on and is never heard from again.
const { on, standby } = HandWrittenCamera.replies
const NeverComesBack = [
	{
		name: 'accepts connections but answers nothing',
		wakeUp: [{ atMs: 0, does: 'goes-silent' }],
	},
	{
		name: 'refuses connections',
		wakeUp: [
			{ atMs: 0, does: 'goes-silent' },
			{ atMs: 100, does: 'drops-connection' },
			{ atMs: 100, does: 'refuses-connections' },
		],
	},
] as const

describe('camera told to power on', () => {
	// Fake only the timers, not the sockets, so that a wake window of a
	// minute takes no real time.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	/** How long a camera of no known model is given to wake. */
	const { wakeWindowMs } = GenericVisca

	test.each(NeverComesBack)(
		'never answers again ($name): connecting for the wake window, then failed',
		async ({ wakeUp }) => {
			const camera = await SimulatedCamera.start({ power: 'standby', replies: { on, standby, wakeUp } })

			const module = await ModuleUnderTest.start({
				host: '127.0.0.1',
				port: String(camera.port),
				pollEnabled: true,
				pollInterval: 1000,
				pollGroups: ['power', 'position', 'lens'],
			})
			try {
				await eventually(() => {
					expect(module.variable('power')).toBe('standby')
				})

				await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
				await eventually(() => {
					expect(camera.received).toContainEqual(CameraPowerBytes)
				})

				// Nearly to the end of the wake window, the camera is waking.
				await timePasses(wakeWindowMs - 1000)
				expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok, InstanceStatus.Connecting])
				expect(saidWaking(module)).toHaveLength(1)
				expect(logged(module, 'warn', 'error')).toEqual([])

				// A command is still sent to a camera that takes connections.
				const connectionsRefused = wakeUp.some(({ does }) => does === 'refuses-connections')
				if (!connectionsRefused) {
					const received = camera.received.length
					await module.executeAction(PowerActionId.CameraPowerState, { bool: 'off' })
					await eventually(() => {
						expect(camera.received.slice(received)).toContainEqual(CameraStandbyBytes)
					}, 500)
				}

				// It ought to have answered by now.
				await timePasses(2000)
				expect(module.statuses[3]).toBe(InstanceStatus.ConnectionFailure)
				expect(logged(module, 'warn')[0]).toBe(
					`Camera didn't answer within ${wakeWindowMs / 1000} s of being told to power on`,
				)
				await timePasses(Recovery)
				expect(saidWaking(module)).toHaveLength(1)
				if (connectionsRefused) {
					// No connection can be made, so failed is how it stays.
					expect(module.statuses).toHaveLength(4)
				}
			} finally {
				await module.destroy()
				await camera.stop()
			}
		},
	)

	test('answers at once: status stays ok, and nothing more is logged than for any command', async () => {
		const camera = await SimulatedCamera.start({ power: 'standby', replies: { on, standby } })

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: true,
			pollInterval: 1000,
			pollGroups: ['power', 'position', 'lens'],
		})
		try {
			await eventually(() => {
				expect(module.variable('power')).toBe('standby')
			})
			const loggedBefore = module.logs.length

			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
			await eventually(() => {
				expect(module.variable('power')).toBe('on')
			})
			await timePasses(wakeWindowMs + 1000)

			expect(module.variable('focus_mode')).toBe('auto')
			expect(module.statuses).toEqual([InstanceStatus.Connecting, InstanceStatus.Ok])
			expect(module.logs.slice(loggedBefore)).toEqual([])
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})

	test('status polling off, and the camera drops the connection as it wakes: connecting, then ok once a connection is made', async () => {
		const camera = await SimulatedCamera.start({
			power: 'standby',
			replies: {
				on,
				standby,
				wakeUp: [
					{ atMs: 100, does: 'drops-connection' },
					{ atMs: 100, does: 'refuses-connections' },
					{ atMs: 10_000, does: 'accepts-connections' },
				],
			},
		})

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(camera.port),
			pollEnabled: false,
		})
		try {
			await eventually(() => {
				expect(module.status).toBe(InstanceStatus.Ok)
			})

			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'on' })
			await eventually(() => {
				expect(module.status).toBe(InstanceStatus.Connecting)
			})
			await eventually(() => {
				expect(module.status).toBe(InstanceStatus.Ok)
			}, 10_000 + Recovery)

			expect(module.statuses).toEqual([
				InstanceStatus.Connecting,
				InstanceStatus.Ok,
				InstanceStatus.Connecting,
				InstanceStatus.Ok,
			])
			expect(saidWaking(module)).toHaveLength(1)
			expect(logged(module, 'warn', 'error')).toEqual([])

			// Commands reach the camera, and they are all it was sent.
			await module.executeAction(PowerActionId.CameraPowerState, { bool: 'off' })
			await eventually(() => {
				expect(camera.power).toBe('standby')
			})
			expect(camera.received).toEqual([CameraPowerBytes, CameraStandbyBytes])
		} finally {
			await module.destroy()
			await camera.stop()
		}
	})
})
