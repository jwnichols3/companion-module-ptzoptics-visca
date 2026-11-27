import net from 'node:net'
import type { CameraPowerState } from '../../../camera/power.js'
import { ACKCompletion, SyntaxErrorBytes } from '../camera-interactions/bytes.js'
import type { Bytes } from '../../../utils/byte.js'

/** The bytes a camera sends in reply to one inquiry. */
type InquiryReply = {
	readonly inquiry: Bytes
	readonly reply: Bytes
}

/** How a camera answers inquiries while in one power state. */
type StateReplies = {
	readonly replies: readonly InquiryReply[]
	/** The reply to any inquiry not listed in `replies`. */
	readonly otherwise: Bytes
}

/**
 * One thing a camera does as it wakes from standby, and how many milliseconds
 * after being told to power on it does it.
 */
export type WakeUpStep = { readonly atMs: number } & (
	| {
			/**
			 * Ignore every message received from now on, on any connection,
			 * without closing a connection.  Messages ignored are never
			 * answered.
			 */
			readonly does: 'goes-silent'
	  }
	| { readonly does: 'drops-connection' }
	| { readonly does: 'refuses-connections' }
	| { readonly does: 'accepts-connections' }
	| {
			/** Answer inquiries this way from now on. */
			readonly does: 'answers'
			readonly replies: StateReplies
			/** Bytes nothing asked for, sent straight after the next reply. */
			readonly unsolicited: Bytes
	  }
)

/**
 * How a camera answers inquiries in each power state, and what it does as it
 * wakes from standby, as plain data, so that what was recorded from a real
 * camera can be played back.
 */
export type CameraReplies = { readonly [state in CameraPowerState]: StateReplies } & {
	/**
	 * What the camera does after it's told to power on, in order.  Once the
	 * last step is done the camera is awake, answering as that step left it.
	 * A camera with no steps is on, and answers so, at once.
	 */
	readonly wakeUp?: readonly WakeUpStep[]
}

type SimulatedCameraOptions = {
	/** The power state of the camera when it starts. */
	readonly power: CameraPowerState
	readonly replies: CameraReplies
	/**
	 * How many times faster than its steps say the camera wakes up, to
	 * shorten a wake-up that took a real camera half a minute.  1 if omitted.
	 */
	readonly wakeUpSpeed?: number
	/**
	 * How many milliseconds the camera takes over each reply, as a real
	 * camera takes about ten: every reply is sent this long after its message
	 * arrives.  0 if omitted.
	 */
	readonly latencyMs?: number
	/** The address to listen on.  `127.0.0.1` if omitted. */
	readonly host?: string
	/** The TCP port to listen on.  One the OS chooses if omitted. */
	readonly port?: number
	/**
	 * Called with a line of text for each message the camera receives and
	 * each change in its state, for a person to read.
	 */
	readonly log?: (line: string) => void
}

const PowerOnBytes = [0x81, 0x01, 0x04, 0x00, 0x02, 0xff]
const PowerStandbyBytes = [0x81, 0x01, 0x04, 0x00, 0x03, 0xff]

/** Something the camera does wrong with one reply. */
type ReplyFault =
	| {
			/** How many milliseconds late to send the reply. */
			readonly late: number
	  }
	| {
			/** The bytes to send in place of the reply. */
			readonly garbled: Bytes
	  }

/** The socket number the simulated camera uses in every ACK and Completion. */
const Socket = 1

/** Write bytes the way a capture does (`90 50 02 FF`). */
function hex(bytes: Bytes): string {
	return bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ')
}

function sameBytes(b1: Bytes, b2: Bytes): boolean {
	return b1.length === b2.length && b1.every((b, i) => b === b2[i])
}

/**
 * A stand-in camera: a local TCP server that holds power state, answers each
 * inquiry with the reply given for its current power state, acknowledges and
 * completes every command, and records every message it receives.  It can
 * also be told to misbehave: to refuse or drop connections, to stall, and to
 * send a reply late or garbled.
 *
 * Told to go to standby, it answers as in standby.  Told to power on, it
 * wakes up the way its replies say a camera does, then answers as on.
 *
 * Where `RunCameraInteractionTest` scripts one exact exchange with a
 * `VISCAPort`, this keeps answering for as long as it's asked, so that a whole
 * module can run against it.
 */
export class SimulatedCamera {
	readonly #server: net.Server
	readonly #sockets = new Set<net.Socket>()
	readonly #replies: CameraReplies
	#power: CameraPowerState

	/** How the camera answers inquiries at the moment. */
	#answers: StateReplies

	readonly #wakeUpSpeed: number
	readonly #latencyMs: number
	readonly #host: string
	readonly #log: (line: string) => void

	/** Timers for the steps not yet done of a wake-up in progress. */
	#wakeUpTimers: ReturnType<typeof setTimeout>[] = []

	/** Bytes nothing asked for, to send straight after the next reply. */
	#unsolicited: Bytes = []

	/** What to do wrong with the replies to the next messages received, in order. */
	readonly #replyFaults: ReplyFault[] = []

	/** Messages received during a stall and not yet acted on, if stalled. */
	#stalled: { readonly socket: net.Socket; readonly message: Bytes }[] | null = null
	#stallTimer: ReturnType<typeof setTimeout> | null = null

	/** Whether the camera is ignoring every message it receives. */
	#silent = false

	/** The TCP port the camera is listening on. */
	readonly port: number

	/** Every message the camera has received, oldest first. */
	readonly received: Bytes[] = []

	/** When each message in `received` arrived, in milliseconds, by `performance.now()`. */
	readonly receivedAt: number[] = []

	private constructor(
		server: net.Server,
		port: number,
		{ power, replies, wakeUpSpeed = 1, latencyMs = 0, host = '127.0.0.1', log = () => {} }: SimulatedCameraOptions,
	) {
		this.#server = server
		this.#host = host
		this.#log = log
		this.port = port
		this.#power = power
		this.#replies = replies
		this.#answers = replies[power]
		this.#wakeUpSpeed = wakeUpSpeed
		this.#latencyMs = latencyMs

		server.on('connection', (socket: net.Socket) => {
			this.#sockets.add(socket)
			socket.once('close', () => {
				this.#sockets.delete(socket)
			})
			// The far end vanishing isn't this camera's problem.
			socket.on('error', () => {})

			// Messages may arrive split across packets or several to a
			// packet, so accumulate bytes and peel off whole messages.
			let pending: number[] = []
			socket.on('data', (data: Buffer) => {
				pending.push(...data)
				for (;;) {
					const terminator = pending.indexOf(0xff)
					if (terminator < 0) {
						break
					}
					const message = pending.slice(0, terminator + 1)
					pending = pending.slice(terminator + 1)

					this.received.push(message)
					this.receivedAt.push(performance.now())
					this.#log(`received ${hex(message)}`)
					if (this.#silent) {
						// Received, and never answered.
					} else if (this.#stalled !== null) {
						this.#stalled.push({ socket, message })
					} else {
						this.#answer(socket, message)
					}
				}
			})
		})
	}

	/** Start a camera listening, on `127.0.0.1` and a port the OS chooses unless told otherwise. */
	static async start(options: SimulatedCameraOptions): Promise<SimulatedCamera> {
		return new Promise((resolve: (camera: SimulatedCamera) => void, reject: (err: Error) => void) => {
			const server = net.createServer({ noDelay: true })

			server.on('error', reject)

			const randomlyChosenPort = 0
			server.listen(options.port ?? randomlyChosenPort, options.host ?? '127.0.0.1', () => {
				const addr = server.address()
				if (typeof addr === 'string' || addr === null) {
					reject(new Error('server not running on an IP socket?'))
					return
				}

				resolve(new SimulatedCamera(server, addr.port, options))
			})
		})
	}

	/** The camera's current power state. */
	get power(): CameraPowerState {
		return this.#power
	}

	/**
	 * Stop listening, so that attempts to connect are refused, as when the
	 * camera is off the network.  Connections already made stay open.
	 */
	refuseConnections(): void {
		this.#server.close()
	}

	/** Listen again on the same port after `refuseConnections()`. */
	async acceptConnections(): Promise<void> {
		return new Promise((resolve: () => void, reject: (err: Error) => void) => {
			this.#server.once('error', reject)
			this.#server.listen(this.port, this.#host, () => {
				this.#server.off('error', reject)
				resolve()
			})
		})
	}

	/** Close every connection to the camera, as when it loses power. */
	dropConnection(): void {
		for (const socket of this.#sockets) {
			socket.destroy()
		}
	}

	/**
	 * Stop acting on and replying to messages until `release()`.  Messages
	 * are still received and recorded meanwhile.
	 */
	hold(): void {
		this.#stalled ??= []
	}

	/** Act on everything received since `hold()`, in order, and answer as usual again. */
	release(): void {
		if (this.#stallTimer !== null) {
			clearTimeout(this.#stallTimer)
			this.#stallTimer = null
		}
		const stalled = this.#stalled ?? []
		this.#stalled = null
		for (const { socket, message } of stalled) {
			this.#answer(socket, message)
		}
	}

	/**
	 * Stop acting on and replying to messages for the given number of
	 * milliseconds, then act on everything received meanwhile, in order.
	 */
	stall(ms: number): void {
		this.hold()
		if (this.#stallTimer !== null) {
			clearTimeout(this.#stallTimer)
		}
		this.#stallTimer = setTimeout(() => {
			this.release()
		}, ms)
	}

	/**
	 * Send the reply to the next message received the given number of
	 * milliseconds late.  Replies to later messages aren't held up behind it.
	 */
	replyLate(ms: number): void {
		this.#replyFaults.push({ late: ms })
	}

	/**
	 * Send the given bytes in place of the reply to the next message received.
	 * The camera still acts on the message.
	 */
	replyGarbled(bytes: Bytes): void {
		this.#replyFaults.push({ garbled: bytes })
	}

	/**
	 * Answer inquiries the given way from now on, whatever the power state,
	 * until the power state next changes.
	 */
	answerAs(replies: StateReplies): void {
		this.#answers = replies
	}

	/** Send the given bytes now, on every connection, though nothing asked for them. */
	send(bytes: Bytes): void {
		for (const socket of this.#sockets) {
			socket.write(new Uint8Array(bytes))
		}
	}

	/** Close every connection to the camera and stop listening. */
	async stop(): Promise<void> {
		this.#abandonWakeUp()
		if (this.#stallTimer !== null) {
			clearTimeout(this.#stallTimer)
			this.#stallTimer = null
		}
		for (const socket of this.#sockets) {
			socket.destroy()
		}
		return new Promise((resolve: () => void) => {
			this.#server.close(() => {
				resolve()
			})
		})
	}

	/** Act on one received message and reply to it, misbehaving as instructed. */
	#answer(socket: net.Socket, message: Bytes): void {
		let reply = this.#replyTo(message)
		if (this.#unsolicited.length > 0) {
			reply = [...reply, ...this.#unsolicited]
			this.#unsolicited = []
		}

		const send = (bytes: Bytes) => {
			// The connection may have been dropped since the message arrived.
			if (!socket.destroyed) {
				socket.write(new Uint8Array(bytes))
			}
		}

		const fault = this.#replyFaults.shift()
		const bytes = fault !== undefined && 'garbled' in fault ? fault.garbled : reply
		const afterMs = this.#latencyMs + (fault !== undefined && 'late' in fault ? fault.late : 0)
		if (afterMs === 0) {
			send(bytes)
		} else {
			setTimeout(() => {
				send(bytes)
			}, afterMs)
		}
	}

	/** Act on one received message, returning the bytes to send in reply. */
	#replyTo(message: Bytes): Bytes {
		const [header, type] = message
		if (header !== 0x81) {
			return SyntaxErrorBytes
		}

		switch (type) {
			// Command
			case 0x01:
				if (sameBytes(message, PowerOnBytes)) {
					if (this.#power === 'standby') {
						this.#power = 'on'
						this.#wakeUp()
					}
				} else if (sameBytes(message, PowerStandbyBytes)) {
					if (this.#power === 'on') {
						this.#log('power standby')
					}
					this.#abandonWakeUp()
					this.#power = 'standby'
					this.#answers = this.#replies.standby
				}
				return ACKCompletion(Socket)
			// Inquiry
			case 0x09: {
				const { replies, otherwise } = this.#answers
				return replies.find(({ inquiry }) => sameBytes(inquiry, message))?.reply ?? otherwise
			}
			default:
				return SyntaxErrorBytes
		}
	}

	/** Start doing what the camera does as it wakes from standby. */
	#wakeUp(): void {
		const { wakeUp = [], on } = this.#replies
		if (wakeUp.length === 0) {
			this.#answers = on
			this.#log('power on')
			return
		}

		const takesMs = (wakeUp.at(-1)?.atMs ?? 0) / this.#wakeUpSpeed
		this.#log(`power on: waking for ${(takesMs / 1000).toFixed(1)} s`)

		for (const step of wakeUp) {
			const stepDone = () => {
				this.#wakeUpStep(step)
				if (step === wakeUp.at(-1)) {
					this.#log('awake')
				}
			}
			// What the camera does at once, it does before it answers
			// anything more.
			if (step.atMs === 0) {
				stepDone()
				continue
			}
			this.#wakeUpTimers.push(setTimeout(stepDone, step.atMs / this.#wakeUpSpeed))
		}
	}

	#wakeUpStep(step: WakeUpStep): void {
		this.#log(`waking: ${step.does}`)
		switch (step.does) {
			case 'goes-silent':
				this.#silent = true
				break
			case 'drops-connection':
				this.dropConnection()
				break
			case 'refuses-connections':
				this.refuseConnections()
				break
			case 'accepts-connections':
				if (!this.#server.listening) {
					// Nothing to be done if the port can't be had again.
					this.acceptConnections().catch(() => {})
				}
				break
			case 'answers':
				this.#silent = false
				this.#answers = step.replies
				this.#unsolicited = step.unsolicited
				break
		}
	}

	/** Stop a wake-up in progress, leaving the camera answering. */
	#abandonWakeUp(): void {
		for (const timer of this.#wakeUpTimers) {
			clearTimeout(timer)
		}
		this.#wakeUpTimers = []
		this.#silent = false
		this.#unsolicited = []
	}
}
