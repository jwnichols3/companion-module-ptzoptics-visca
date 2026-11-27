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
 * How a camera answers inquiries in each power state, as plain data, so that
 * replies recorded from a real camera can be played back.
 */
export type CameraReplies = { readonly [state in CameraPowerState]: StateReplies }

type SimulatedCameraOptions = {
	/** The power state of the camera when it starts. */
	readonly power: CameraPowerState
	readonly replies: CameraReplies
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
 * Where `RunCameraInteractionTest` scripts one exact exchange with a
 * `VISCAPort`, this keeps answering for as long as it's asked, so that a whole
 * module can run against it.
 */
export class SimulatedCamera {
	readonly #server: net.Server
	readonly #sockets = new Set<net.Socket>()
	readonly #replies: CameraReplies
	#power: CameraPowerState

	/** What to do wrong with the replies to the next messages received, in order. */
	readonly #replyFaults: ReplyFault[] = []

	/** Messages received during a stall and not yet acted on, if stalled. */
	#stalled: { readonly socket: net.Socket; readonly message: Bytes }[] | null = null
	#stallTimer: ReturnType<typeof setTimeout> | null = null

	/** The TCP port the camera is listening on, on `127.0.0.1`. */
	readonly port: number

	/** Every message the camera has received, oldest first. */
	readonly received: Bytes[] = []

	private constructor(server: net.Server, port: number, { power, replies }: SimulatedCameraOptions) {
		this.#server = server
		this.port = port
		this.#power = power
		this.#replies = replies

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
					if (this.#stalled !== null) {
						this.#stalled.push({ socket, message })
					} else {
						this.#answer(socket, message)
					}
				}
			})
		})
	}

	/** Start a camera listening on a port the OS chooses. */
	static async start(options: SimulatedCameraOptions): Promise<SimulatedCamera> {
		return new Promise((resolve: (camera: SimulatedCamera) => void, reject: (err: Error) => void) => {
			const server = net.createServer({ noDelay: true })

			server.on('error', reject)

			const randomlyChosenPort = 0
			server.listen(randomlyChosenPort, '127.0.0.1', () => {
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
			this.#server.listen(this.port, '127.0.0.1', () => {
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
	 * Stop acting on and replying to messages for the given number of
	 * milliseconds, then act on everything received meanwhile, in order.
	 */
	stall(ms: number): void {
		this.#stalled ??= []
		if (this.#stallTimer !== null) {
			clearTimeout(this.#stallTimer)
		}
		this.#stallTimer = setTimeout(() => {
			const stalled = this.#stalled ?? []
			this.#stalled = null
			this.#stallTimer = null
			for (const { socket, message } of stalled) {
				this.#answer(socket, message)
			}
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

	/** Close every connection to the camera and stop listening. */
	async stop(): Promise<void> {
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
		const reply = this.#replyTo(message)

		const send = (bytes: Bytes) => {
			// The connection may have been dropped since the message arrived.
			if (!socket.destroyed) {
				socket.write(new Uint8Array(bytes))
			}
		}

		const fault = this.#replyFaults.shift()
		if (fault === undefined) {
			send(reply)
		} else if ('late' in fault) {
			setTimeout(() => {
				send(reply)
			}, fault.late)
		} else {
			send(fault.garbled)
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
					this.#power = 'on'
				} else if (sameBytes(message, PowerStandbyBytes)) {
					this.#power = 'standby'
				}
				return ACKCompletion(Socket)
			// Inquiry
			case 0x09: {
				const { replies, otherwise } = this.#replies[this.#power]
				return replies.find(({ inquiry }) => sameBytes(inquiry, message))?.reply ?? otherwise
			}
			default:
				return SyntaxErrorBytes
		}
	}
}
