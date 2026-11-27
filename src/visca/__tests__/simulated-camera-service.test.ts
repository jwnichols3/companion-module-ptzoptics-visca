import { spawn } from 'node:child_process'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { eventually, timePasses } from '../../__tests__/faked-time.js'
import { Cameras } from './simulator/cameras.js'
import { type Service, startService, UsageError } from './simulator/service.js'
import { SimulatedCamera } from './simulator/simulated-camera.js'

const PowerInquiry = [0x81, 0x09, 0x04, 0x00, 0xff]
const PowerOn = [0x81, 0x01, 0x04, 0x00, 0x02, 0xff]
const PowerOff = [0x81, 0x01, 0x04, 0x00, 0x03, 0xff]

const AnswersOn = [0x90, 0x50, 0x02, 0xff]
const AnswersStandby = [0x90, 0x50, 0x03, 0xff]
const ACKCompletion = [0x90, 0x41, 0xff, 0x90, 0x51, 0xff]

/** A camera that's on as soon as it's told to be, so that nothing here waits on a wake-up. */
const Camera = 'refuses-inquiries-in-standby'

/** A camera recorded only while on, which left some inquiries unanswered. */
const CameraRecordedOn = 'ptzoptics-unidentified-a'

/** A camera recorded only while in standby. */
const CameraRecordedInStandby = 'avkans-unidentified'

const PanTiltInquiry = [0x81, 0x09, 0x06, 0x12, 0xff]
/** An inquiry `CameraRecordedOn` left unanswered. */
const ColorTemperatureInquiry = [0x81, 0x09, 0x04, 0x20, 0xff]

/** A plain TCP connection to the service, as a client of a camera makes. */
class Client {
	readonly #socket: net.Socket
	#received: number[] = []
	#waiting: (() => void) | null = null

	private constructor(socket: net.Socket) {
		this.#socket = socket
		socket.on('data', (data: Buffer) => {
			this.#received.push(...data)
			this.#waiting?.()
		})
	}

	static async connect(port: number): Promise<Client> {
		return new Promise((resolve: (client: Client) => void, reject: (err: Error) => void) => {
			const socket = net.connect(port, '127.0.0.1', () => {
				resolve(new Client(socket))
			})
			socket.once('error', reject)
		})
	}

	/** Send a message and return the given number of bytes sent back. */
	async send(message: readonly number[], replyLength: number): Promise<number[]> {
		this.#socket.write(new Uint8Array(message))
		while (this.#received.length < replyLength) {
			await new Promise<void>((resolve: () => void) => {
				this.#waiting = resolve
			})
		}
		const reply = this.#received.slice(0, replyLength)
		this.#received = this.#received.slice(replyLength)
		return reply
	}

	/** Send a message and wait for the far end to close the connection. */
	async closedAfter(message: readonly number[]): Promise<void> {
		const closed = new Promise<void>((resolve: () => void) => {
			this.#socket.once('close', resolve)
		})
		this.#socket.write(new Uint8Array(message))
		return closed
	}

	close(): void {
		this.#socket.destroy()
	}
}

describe('simulated camera as a network service', () => {
	let service: Service | null = null
	let client: Client | null = null
	let printed: string[] = []

	async function start(...argv: string[]): Promise<Client> {
		printed = []
		service = await startService(argv, (line: string) => printed.push(line))
		if (service === null) {
			throw new Error('no service was started')
		}
		client = await Client.connect(service.port)
		return client
	}

	afterEach(async () => {
		client?.close()
		await service?.stop()
		service = null
		client = null
	})

	test('plays the named camera in standby', async () => {
		const client = await start(Camera, '--state', 'standby', '--port', '0')

		expect(await client.send(PowerInquiry, 4)).toEqual(AnswersStandby)
	})

	test('plays the named camera powered on, the state if none is given', async () => {
		const client = await start(Camera, '--port', '0')

		expect(await client.send(PowerInquiry, 4)).toEqual(AnswersOn)
	})

	test('Power On and Power Off from a client change its state', async () => {
		const client = await start(Camera, '--state', 'standby', '--port', '0')

		expect(await client.send(PowerOn, 6)).toEqual(ACKCompletion)
		expect(await client.send(PowerInquiry, 4)).toEqual(AnswersOn)

		expect(await client.send(PowerOff, 6)).toEqual(ACKCompletion)
		expect(await client.send(PowerInquiry, 4)).toEqual(AnswersStandby)
	})

	test('prints each message received and each state change', async () => {
		const client = await start(Camera, '--state', 'standby', '--port', '0')
		await client.send(PowerInquiry, 4)
		await client.send(PowerOn, 6)
		await client.send(PowerOff, 6)

		expect(printed).toEqual([
			`${Camera} in standby, listening on 127.0.0.1:${service?.port}`,
			'received 81 09 04 00 FF',
			'received 81 01 04 00 02 FF',
			'power on',
			'received 81 01 04 00 03 FF',
			'power standby',
		])
	})

	test('plays a recorded wake-up, shortened as asked', async () => {
		const client = await start('ptzoptics', '--state', 'standby', '--port', '0', '--wake-up-speed', '1000')
		await client.send(PowerOn, 6)

		await expect.poll(() => printed.at(-1)).toBe('awake')
		expect(printed).toContain('waking: goes-silent')

		// The camera dropped the connection as it woke.
		const again = await Client.connect(service?.port ?? 0)
		expect(await again.send(PowerInquiry, 4)).toEqual(AnswersOn)
		again.close()
	})

	test('plays a camera recorded in one power state only, in that state', async () => {
		const client = await start(CameraRecordedInStandby, '--state', 'standby', '--port', '0')

		expect(await client.send(PowerInquiry, 4)).toEqual(AnswersStandby)
		expect(await client.send(PanTiltInquiry, 4)).toEqual([0x90, 0x61, 0x41, 0xff])
	})

	test.each([
		[[CameraRecordedInStandby, '--port', '0'], `${CameraRecordedInStandby} wasn't recorded on`],
		[[CameraRecordedOn, '--state', 'standby', '--port', '0'], `${CameraRecordedOn} wasn't recorded in standby`],
	])(
		'refuses to play a camera in a power state it was not recorded in: %j',
		async (argv: string[], message: string) => {
			await expect(startService(argv, () => {})).rejects.toThrow(new UsageError(message))
		},
	)

	test('answers nothing to an inquiry the camera was recorded leaving unanswered', async () => {
		const client = await start(CameraRecordedOn, '--port', '0')

		// Had the first inquiry been answered, its answer would come first.
		expect(await client.send([...ColorTemperatureInquiry, ...PowerInquiry], 4)).toEqual(AnswersOn)
		expect(printed.slice(1)).toEqual(['received 81 09 04 20 FF', 'received 81 09 04 00 FF'])
	})

	test('gives up, rather than make up a power state the camera was not recorded in', async () => {
		const client = await start(CameraRecordedOn, '--port', '0')
		expect(await client.send(PowerInquiry, 4)).toEqual(AnswersOn)

		// Neither acknowledged nor obeyed: the connection is closed, no
		// more are accepted, and stopping the camera says why.
		await client.closedAfter(PowerOff)
		expect(printed.slice(2)).toEqual([
			'received 81 01 04 00 03 FF',
			'gave up: told to be in standby, with no replies for that state',
		])
		await expect(Client.connect(service?.port ?? 0)).rejects.toThrow('ECONNREFUSED')
		await expect(service?.stop()).rejects.toThrow(
			'The simulated camera was told to be in standby, and has no replies for that state',
		)
		service = null
	})

	test('lists the cameras it can play when asked, and the one power state of a camera recorded in only one', async () => {
		const printed: string[] = []

		expect(await startService(['--list'], (line: string) => printed.push(line))).toBeNull()
		expect(printed).toContain('  ptzoptics')
		expect(printed).toContain(`  ${Camera}`)
		expect(printed).toContain(`  ${CameraRecordedOn} (on only)`)
		expect(printed).toContain(`  ${CameraRecordedInStandby} (standby only)`)
	})

	test('lists the cameras it can play when the name is unknown', async () => {
		const refusal = startService(['no-such-camera'], () => {})

		await expect(refusal).rejects.toThrow(UsageError)
		await expect(refusal).rejects.toThrow(
			/^unknown camera no-such-camera\n(.*\n)* {2}ptzoptics\n(.*\n)* {2}refuses-inquiries-in-standby$/,
		)
	})

	test.each([
		[['ptzoptics', '--state', 'waking'], '--state must be on or standby'],
		[['ptzoptics', '--port', 'http'], '--port must be a port number'],
		[['ptzoptics', '--wake-up-speed', '0'], '--wake-up-speed must be a number above zero'],
		[['ptzoptics', '--loud'], 'unknown argument --loud'],
		[[], 'no camera named'],
	])('refuses %j', async (argv: string[], message: string) => {
		await expect(startService(argv, () => {})).rejects.toThrow(new UsageError(message))
	})

	test('runs from the command line until interrupted', async () => {
		const script = fileURLToPath(new URL('../../../tools/sim-camera.mjs', import.meta.url))
		const child = spawn(process.execPath, [script, Camera, '--state', 'standby', '--port', '0'])
		let stdout = ''
		child.stdout.on('data', (data: Buffer) => {
			stdout += data.toString()
		})
		const exited = new Promise((resolve: (code: number | null) => void) => {
			child.once('exit', resolve)
		})

		try {
			await expect.poll(() => stdout, { timeout: 10_000 }).toMatch(/listening on 127\.0\.0\.1:\d+\n/)
			const port = Number(/listening on 127\.0\.0\.1:(\d+)/.exec(stdout)?.[1])

			const client = await Client.connect(port)
			expect(await client.send(PowerInquiry, 4)).toEqual(AnswersStandby)
			expect(await client.send(PowerOn, 6)).toEqual(ACKCompletion)
			expect(await client.send(PowerInquiry, 4)).toEqual(AnswersOn)

			// As Ctrl-C does.
			child.kill('SIGINT')
			expect(await exited).toBe(0)
			await expect(Client.connect(port)).rejects.toThrow('ECONNREFUSED')

			const time = '\\d\\d:\\d\\d:\\d\\d '
			expect(stdout).toMatch(
				new RegExp(
					[
						`^${time}${Camera} in standby, listening on 127\\.0\\.0\\.1:${port}`,
						`${time}received 81 09 04 00 FF`,
						`${time}received 81 01 04 00 02 FF`,
						`${time}power on`,
						`${time}received 81 09 04 00 FF`,
						`${time}stopping\n$`,
					].join('\n'),
				),
			)
		} finally {
			child.kill()
		}
	}, 20_000)
})

describe('simulated camera playing a capture', () => {
	// Fake only the timers, not the sockets, so that the time the camera
	// takes over a reply takes no real time.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	test('takes as long over a reply as the camera was recorded taking, if asked to', async () => {
		const replies = Cameras.find(({ id }) => id === CameraRecordedOn)?.replies
		const slowest = replies?.on?.replies.reduce((slowest, reply) =>
			(reply.tookMs ?? 0) > (slowest.tookMs ?? 0) ? reply : slowest,
		)
		if (replies === undefined || slowest === undefined || slowest.reply === null || slowest.tookMs === undefined) {
			throw new Error(`The capture of ${CameraRecordedOn} on is missing, or lacks reply times`)
		}
		// One answer in each capture so far took a third of a second, twenty
		// times as long as the rest.
		expect(slowest.tookMs).toBeGreaterThan(300)

		const camera = await SimulatedCamera.start({ power: 'on', replies, latencyMs: 'recorded' })
		const client = await Client.connect(camera.port)
		try {
			let answered = false
			const answer = client.send(slowest.inquiry, slowest.reply.length).finally(() => {
				answered = true
			})

			// The camera's time starts when the inquiry reaches it.
			await eventually(() => {
				expect(camera.received).toEqual([slowest.inquiry])
			})
			await timePasses(slowest.tookMs - 50)
			expect(answered).toBe(false)
			await eventually(() => {
				expect(answered).toBe(true)
			}, 100)
			expect(await answer).toEqual(slowest.reply)
		} finally {
			client.close()
			await camera.stop()
		}
	})
})
