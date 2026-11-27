import { Cameras } from './cameras.js'
import { SimulatedCamera } from './simulated-camera.js'

/** The port PTZOptics cameras listen on for VISCA over TCP. */
const DefaultPort = 5678

/** The command line asked for something the service can't do. */
export class UsageError extends Error {}

/** A simulated camera running as a network service. */
export type Service = {
	/** The TCP port the camera is listening on. */
	readonly port: number
	/** Close every connection to the camera and stop listening. */
	stop(): Promise<void>
}

function cameraList(): string {
	return ['cameras:', ...Cameras.map(({ id }) => `  ${id}`)].join('\n')
}

/**
 * Do what the command line of `tools/sim-camera.mjs` asks: start a simulated
 * camera for a real client to connect to, printing a line for each message
 * it receives and each change in its state, or print the cameras it can play
 * and start nothing.  `time` is written before each line about the running
 * camera.
 */
export async function startService(
	argv: readonly string[],
	print: (line: string) => void,
	time: () => string = () => '',
): Promise<Service | null> {
	let id: string | undefined
	let power = 'on'
	let host = '127.0.0.1'
	let port = DefaultPort
	let wakeUpSpeed = 1

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		const value = () => argv[++i] ?? ''
		switch (arg) {
			case '--list':
				cameraList().split('\n').forEach(print)
				return null
			case '--state':
				power = value()
				break
			case '--host':
				host = value()
				break
			case '--port':
				port = Number(value() || NaN)
				break
			case '--wake-up-speed':
				wakeUpSpeed = Number(value() || NaN)
				break
			default:
				if (arg.startsWith('-') || id !== undefined) {
					throw new UsageError(`unknown argument ${arg}`)
				}
				id = arg
		}
	}

	if (id === undefined) {
		throw new UsageError('no camera named')
	}
	const camera = Cameras.find((camera) => camera.id === id)
	if (camera === undefined) {
		throw new UsageError(`unknown camera ${id}\n${cameraList()}`)
	}
	if (power !== 'on' && power !== 'standby') {
		throw new UsageError('--state must be on or standby')
	}
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new UsageError('--port must be a port number')
	}
	if (!(wakeUpSpeed > 0)) {
		throw new UsageError('--wake-up-speed must be a number above zero')
	}

	const log = (line: string) => {
		print(`${time()}${line}`)
	}
	const simulated = await SimulatedCamera.start({ power, replies: camera.replies, wakeUpSpeed, host, port, log })
	log(`${id} ${power === 'on' ? 'powered on' : 'in standby'}, listening on ${host}:${simulated.port}`)
	return simulated
}

const Usage =
	'usage: sim-camera.mjs <camera> [--state on|standby] [--port <port>] [--host <address>] [--wake-up-speed <times>]\n' +
	'       sim-camera.mjs --list'

/**
 * Run the service from the command line until interrupted, printing to
 * stdout, with the time of day before each line about the running camera.
 */
export async function main(argv: readonly string[]): Promise<void> {
	const print = (line: string) => {
		console.log(line)
	}
	const time = () => `${new Date().toTimeString().slice(0, 8)} `

	let service: Service | null
	try {
		service = await startService(argv, print, time)
	} catch (err) {
		if (err instanceof UsageError) {
			console.error(`${err.message}\n${Usage}`)
			process.exitCode = 2
		} else {
			console.error(String(err))
			process.exitCode = 1
		}
		return
	}
	if (service === null) {
		return
	}

	const stop = () => {
		print(`${time()}stopping`)
		void service.stop()
	}
	process.once('SIGINT', stop)
	process.once('SIGTERM', stop)
}
