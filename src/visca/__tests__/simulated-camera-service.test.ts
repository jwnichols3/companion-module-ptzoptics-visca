import { spawn } from 'node:child_process'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { type Service, startService, UsageError } from './simulator/service.js'

const PowerInquiry = [0x81, 0x09, 0x04, 0x00, 0xff]
const PowerOn = [0x81, 0x01, 0x04, 0x00, 0x02, 0xff]
const PowerOff = [0x81, 0x01, 0x04, 0x00, 0x03, 0xff]

const AnswersOn = [0x90, 0x50, 0x02, 0xff]
const AnswersStandby = [0x90, 0x50, 0x03, 0xff]
const ACKCompletion = [0x90, 0x41, 0xff, 0x90, 0x51, 0xff]

/** A camera that's on as soon as it's told to be, so that nothing here waits on a wake-up. */
const Camera = 'refuses-inquiries-in-standby'

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

	test('lists the cameras it can play when asked', async () => {
		const printed: string[] = []

		expect(await startService(['--list'], (line: string) => printed.push(line))).toBeNull()
		expect(printed).toContain('  ptzoptics')
		expect(printed).toContain(`  ${Camera}`)
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
