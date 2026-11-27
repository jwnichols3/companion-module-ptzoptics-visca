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

/** The socket number the simulated camera uses in every ACK and Completion. */
const Socket = 1

function sameBytes(b1: Bytes, b2: Bytes): boolean {
	return b1.length === b2.length && b1.every((b, i) => b === b2[i])
}

/**
 * A stand-in camera: a local TCP server that holds power state, answers each
 * inquiry with the reply given for its current power state, acknowledges and
 * completes every command, and records every message it receives.
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
					socket.write(new Uint8Array(this.#replyTo(message)))
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

	/** Close every connection to the camera and stop listening. */
	async stop(): Promise<void> {
		for (const socket of this.#sockets) {
			socket.destroy()
		}
		return new Promise((resolve: () => void) => {
			this.#server.close(() => {
				resolve()
			})
		})
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
