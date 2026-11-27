#!/usr/bin/env node
// Record how a VISCA-over-IP camera answers the status inquiries this module
// can poll, in one power state, as a JSON capture.
//
//   node tools/capture-camera.mjs <host> <port> --state on|standby|waking \
//        --brand <brand> --model <model> [--firmware <version>] [--out <file>] [--allow-power]
//
// Only read-only inquiries (81 09 ...) are sent.  The one exception is
// `--state waking`, which sends Power On to a camera in standby and records its
// answers until they settle; it is refused unless `--allow-power` is given.
// `--power-off` (also requiring `--allow-power`) sends Power Off and exits.
//
// The capture contains no address or hostname.
//
// Captures saved as src/cameras/captures/<camera>/{on,standby,waking}.json can
// be played back to a real Companion by `tools/sim-camera.mjs`.
import net from 'node:net'
import { writeFileSync } from 'node:fs'

const ScriptVersion = 1

/** The inquiries the module's status poller can send. */
const Inquiries = [
	['power', [0x81, 0x09, 0x04, 0x00, 0xff]],
	['pan-tilt', [0x81, 0x09, 0x06, 0x12, 0xff]],
	['zoom', [0x81, 0x09, 0x04, 0x47, 0xff]],
	['focus', [0x81, 0x09, 0x04, 0x48, 0xff]],
	['focus-mode', [0x81, 0x09, 0x04, 0x38, 0xff]],
	['exposure-mode', [0x81, 0x09, 0x04, 0x39, 0xff]],
	['iris', [0x81, 0x09, 0x04, 0x4b, 0xff]],
	['shutter', [0x81, 0x09, 0x04, 0x4a, 0xff]],
	['gain', [0x81, 0x09, 0x04, 0x4c, 0xff]],
	['brightness', [0x81, 0x09, 0x04, 0x4d, 0xff]],
	['wb-mode', [0x81, 0x09, 0x04, 0x35, 0xff]],
	['wb-red', [0x81, 0x09, 0x04, 0x43, 0xff]],
	['wb-blue', [0x81, 0x09, 0x04, 0x44, 0xff]],
	['flip', [0x81, 0x09, 0x04, 0x66, 0xff]],
	['mirror', [0x81, 0x09, 0x04, 0x61, 0xff]],
	['color-temperature', [0x81, 0x09, 0x04, 0x20, 0xff]],
	['red-tuning', [0x81, 0x09, 0x04, 0x12, 0xff]],
	['blue-tuning', [0x81, 0x09, 0x04, 0x13, 0xff]],
	['saturation', [0x81, 0x09, 0x04, 0x49, 0xff]],
	['hue', [0x81, 0x09, 0x04, 0x4f, 0xff]],
	['contrast', [0x81, 0x09, 0x04, 0xa2, 0xff]],
	['luminance', [0x81, 0x09, 0x04, 0xa1, 0xff]],
	['sharpness', [0x81, 0x09, 0x04, 0x42, 0xff]],
	['exposure-compensation', [0x81, 0x09, 0x04, 0x4e, 0xff]],
]

const VersionInquiry = [0x81, 0x09, 0x00, 0x02, 0xff]
const PowerOn = [0x81, 0x01, 0x04, 0x00, 0x02, 0xff]
const PowerOff = [0x81, 0x01, 0x04, 0x00, 0x03, 0xff]

const ReplyTimeoutMs = 2000
const WakingLimitMs = 120_000
const WakingPassGapMs = 500
const WakingReplyTimeoutMs = 2000
const UnsolicitedQuietMs = 1500

function hex(bytes) {
	return [...bytes].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')
}

function usage(message) {
	if (message) console.error(message)
	console.error(
		'usage: capture-camera.mjs <host> <port> --state on|standby|waking --brand <brand> --model <model>\n' +
			'       [--firmware <version>] [--out <file>] [--allow-power]\n' +
			'       capture-camera.mjs <host> <port> --power-off --allow-power',
	)
	process.exit(2)
}

function parseArgs(argv) {
	const [host, port, ...rest] = argv
	const opts = { host, port: Number(port) }
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i]
		if (arg === '--allow-power') opts.allowPower = true
		else if (arg === '--power-off') opts.powerOff = true
		else if (['--state', '--brand', '--model', '--firmware', '--out'].includes(arg)) opts[arg.slice(2)] = rest[++i]
		else usage(`unknown argument ${arg}`)
	}
	if (!host || !Number.isInteger(opts.port)) usage()
	return opts
}

/** A connection that splits what the camera sends into VISCA messages. */
class Camera {
	#socket
	#buffer = []
	#messages = []
	#waiter = null
	/** Why the connection ended (an error code, or 'closed'), once it has. */
	ended = null

	static async connect(host, port) {
		const camera = new Camera()
		await new Promise((resolve, reject) => {
			camera.#socket = net.connect({ host, port, noDelay: true }, resolve)
			camera.#socket.once('error', reject)
		})
		camera.#socket.on('data', (data) => {
			for (const byte of data) {
				camera.#buffer.push(byte)
				if (byte === 0xff) {
					camera.#messages.push(camera.#buffer)
					camera.#buffer = []
				}
			}
			camera.#waiter?.()
		})
		camera.#socket.on('error', (e) => {
			camera.ended ??= e.code ?? 'error'
		})
		camera.#socket.on('close', () => {
			camera.ended ??= 'closed'
			camera.#waiter?.()
		})
		return camera
	}

	send(bytes) {
		this.#socket.write(Buffer.from(bytes))
	}

	/** The next message from the camera, or null if none arrives in time. */
	async next(timeoutMs) {
		const deadline = Date.now() + timeoutMs
		while (this.#messages.length === 0) {
			const left = deadline - Date.now()
			if (left <= 0 || this.ended !== null) return null
			await new Promise((resolve) => {
				const timer = setTimeout(resolve, left)
				this.#waiter = () => {
					clearTimeout(timer)
					resolve()
				}
			})
			this.#waiter = null
		}
		return this.#messages.shift()
	}

	/**
	 * Send an inquiry and return its answer.  A command's ACK (`y0 4z FF`) or
	 * completion (`y0 5z FF`) that arrives meanwhile is set aside in `stray`.
	 */
	async inquire(bytes, stray = [], timeoutMs = ReplyTimeoutMs) {
		const start = performance.now()
		this.send(bytes)
		for (;;) {
			const message = await this.next(timeoutMs)
			if (message === null) return { sent: hex(bytes), received: null, ms: null }
			const isAckOrCompletion = message.length === 3 && (message[1] & 0xf0) !== 0x60
			if (isAckOrCompletion) {
				stray.push(hex(message))
				continue
			}
			return { sent: hex(bytes), received: hex(message), ms: Math.round(performance.now() - start) }
		}
	}

	/** Collect whatever arrives until the camera has been quiet for `quietMs`. */
	async drain(quietMs) {
		const late = []
		for (let message; (message = await this.next(quietMs)) !== null; ) late.push(hex(message))
		return late
	}

	close() {
		this.#socket.destroy()
	}
}

async function pass(camera, stray, timeoutMs) {
	const exchanges = []
	for (const [name, bytes] of Inquiries) {
		if (camera.ended !== null) break
		exchanges.push({ name, ...(await camera.inquire(bytes, stray, timeoutMs)) })
	}
	return exchanges
}

function sameAnswers(a, b) {
	return a.length === b.length && a.every((exchange, i) => exchange.received === b[i].received)
}

/** Keep trying to connect until the camera accepts, or the time runs out. */
async function reconnect(host, port, deadline) {
	while (performance.now() < deadline) {
		try {
			return await Camera.connect(host, port)
		} catch {
			await new Promise((resolve) => setTimeout(resolve, WakingPassGapMs))
		}
	}
	return null
}

const opts = parseArgs(process.argv.slice(2))
let camera = await Camera.connect(opts.host, opts.port)

if (opts.powerOff) {
	if (!opts.allowPower) usage('--power-off needs --allow-power')
	camera.send(PowerOff)
	const replies = []
	for (let message; (message = await camera.next(3000)) !== null; ) replies.push(hex(message))
	console.log(`Power Off sent; camera replied: ${replies.join(' | ') || '(nothing)'}`)
	camera.close()
	process.exit(0)
}

if (!['on', 'standby', 'waking'].includes(opts.state)) usage('--state must be on, standby or waking')
if (!opts.brand || !opts.model) usage('--brand and --model are required')
if (opts.state === 'waking' && !opts.allowPower) usage('--state waking sends Power On and needs --allow-power')

const power = await camera.inquire(Inquiries[0][1])
const expectedPower = { on: '90 50 02 FF', standby: '90 50 03 FF', waking: '90 50 03 FF' }[opts.state]
if (power.received !== expectedPower) {
	console.error(
		`The camera answered the power inquiry with ${power.received}, not ${expectedPower}: ` +
			`it is not ${opts.state === 'waking' ? 'in standby, ready to be woken' : opts.state}.`,
	)
	camera.close()
	process.exit(1)
}

const capture = {
	camera: {
		brand: opts.brand,
		model: opts.model,
		firmware: opts.firmware ?? null,
		versionReply: (await camera.inquire(VersionInquiry)).received,
	},
	state: opts.state,
	capturedAt: new Date().toISOString().slice(0, 10),
	scriptVersion: ScriptVersion,
}

if (opts.state === 'waking') {
	// A waking camera may ignore inquiries, refuse them, or drop the
	// connection.  Record what it does, pass by pass, until every inquiry is
	// answered the same way twice in a row.
	const stray = []
	const start = performance.now()
	const at = () => Math.round(performance.now() - start)
	camera.send(PowerOn)
	capture.command = hex(PowerOn)
	capture.timeline = []
	capture.settled = false
	let previous = null
	while (performance.now() - start < WakingLimitMs) {
		if (camera.ended !== null) {
			capture.timeline.push({ atMs: at(), event: 'connection-lost', reason: camera.ended })
			camera = await reconnect(opts.host, opts.port, start + WakingLimitMs)
			if (camera === null) break
			capture.timeline.push({ atMs: at(), event: 'connected' })
		}

		// Ask only for power until the camera says it is on.  A waking camera
		// may go quiet without closing the connection, and may answer much
		// later whatever it was asked meanwhile.  So after an unanswered
		// inquiry, start over on a new connection: a late answer then can't be
		// credited to the wrong inquiry.
		let atMs = at()
		const powerExchange = {
			name: Inquiries[0][0],
			...(await camera.inquire(Inquiries[0][1], stray, WakingReplyTimeoutMs)),
		}
		if (powerExchange.received === null && camera.ended === null) {
			capture.timeline.push({ atMs, exchanges: [powerExchange] })
			camera.close()
			camera = await reconnect(opts.host, opts.port, start + WakingLimitMs)
			if (camera === null) break
			capture.timeline.push({ atMs: at(), event: 'connected' })
			continue
		}
		if (powerExchange.received !== '90 50 02 FF') {
			if (powerExchange.received !== null) capture.timeline.push({ atMs, exchanges: [powerExchange] })
			previous = null
			await new Promise((resolve) => setTimeout(resolve, WakingPassGapMs))
			continue
		}

		// A camera that has just woken may still send answers to inquiries it
		// was asked while waking, even ones asked on an earlier connection.
		// Let those arrive, and note them, before recording a pass.
		if (previous === null) {
			const unsolicited = await camera.drain(UnsolicitedQuietMs)
			if (unsolicited.length > 0) capture.timeline.push({ atMs: at(), event: 'unsolicited', received: unsolicited })
		}

		atMs = at()
		const exchanges = await pass(camera, stray, ReplyTimeoutMs)
		capture.timeline.push({ atMs, exchanges })
		const allAnswered =
			exchanges.length === Inquiries.length && exchanges.every(({ received }) => received?.startsWith('90 50'))
		if (allAnswered && previous !== null && sameAnswers(previous, exchanges)) {
			capture.settled = true
			break
		}
		previous = allAnswered ? exchanges : null
		await new Promise((resolve) => setTimeout(resolve, WakingPassGapMs))
	}
	capture.commandReplies = stray
} else {
	capture.exchanges = await pass(camera, [])
}

camera?.close()

const json = JSON.stringify(capture, null, '\t') + '\n'
if (opts.out) {
	writeFileSync(opts.out, json)
	console.log(`Wrote ${opts.out}`)
} else {
	process.stdout.write(json)
}
