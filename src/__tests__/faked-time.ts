import net from 'node:net'
import { vi } from 'vitest'

/** How much faked time goes by between chances for the sockets to do their work. */
const StepMs = 10

/** How much faked time may go by between checks that the sockets are keeping up, if that's checked. */
const SocketsCheckedEveryMs = 250

/** Sends a byte to this process over the network and resolves when it's come back; null if sockets aren't checked. */
let byteGoesRound: (() => Promise<void>) | null = null

/** How much faked time has gone by since the sockets were last checked. */
let sinceSocketsChecked = 0

/**
 * Don't let faked time run ahead of the sockets, from now until the function
 * resolved is called.
 *
 * A chance for the sockets to do their work is nearly always enough for what
 * one end sent to reach the other, but not always: the OS may take a
 * millisecond over it now and then, and by then seconds of faked time could
 * have gone by, enough for the module to give up on an answer the camera sent
 * at once.  A scenario is over too soon for that to matter.  A run of hours
 * is not, so there, every so often, faked time waits for a byte to go from
 * this process to itself and back over a connection of its own: whatever
 * holds up the other connections on this machine holds that one up too.
 */
export async function fakedTimeWaitsForSockets(): Promise<() => Promise<void>> {
	const server = net.createServer({ noDelay: true }, (socket) => {
		socket.pipe(socket)
	})
	await new Promise<void>((resolve) => {
		const randomlyChosenPort = 0
		server.listen(randomlyChosenPort, '127.0.0.1', resolve)
	})
	const client = net.connect({ port: (server.address() as net.AddressInfo).port, host: '127.0.0.1', noDelay: true })
	await new Promise<void>((resolve) => {
		client.once('connect', resolve)
	})

	byteGoesRound = async () =>
		new Promise((resolve) => {
			client.once('data', () => {
				resolve()
			})
			client.write(new Uint8Array([0]))
		})
	sinceSocketsChecked = 0

	return async () => {
		byteGoesRound = null
		client.destroy()
		return new Promise((resolve) => {
			server.close(() => {
				resolve()
			})
		})
	}
}

/**
 * Let the given number of milliseconds of faked time go by.
 *
 * For tests that fake only the timers, not the sockets.  Time goes by in
 * small steps, and between steps whatever the sockets have to deliver is
 * delivered, so a minute of the module polling a simulated camera takes a
 * fraction of a second.
 *
 * @param stepMs
 *    The size of the steps.  A larger step makes hours go by sooner, but
 *    whatever crosses a socket then seems to take longer, by up to a step.
 */
export async function timePasses(ms: number, stepMs = StepMs): Promise<void> {
	for (let passed = 0; passed < ms; passed += stepMs) {
		vi.advanceTimersByTime(stepMs)
		await new Promise((resolve) => {
			setImmediate(resolve)
		})

		sinceSocketsChecked += stepMs
		if (byteGoesRound !== null && sinceSocketsChecked >= SocketsCheckedEveryMs) {
			sinceSocketsChecked = 0
			await byteGoesRound()
		}
	}
}

/**
 * Check the assertion again and again, letting faked time go by as
 * `timePasses` does between checks, until it passes.
 *
 * Does what `vi.waitFor` does, but that lets faked time go by no faster than
 * real time.
 *
 * @throws
 *    What the assertion throws, if it still doesn't pass after `limitMs` of
 *    faked time.
 */
export async function eventually(assertion: () => void, limitMs = 5000): Promise<void> {
	for (let passed = 0; ; passed += StepMs) {
		try {
			assertion()
			return
		} catch (e) {
			if (passed >= limitMs) {
				throw e
			}
		}
		await timePasses(StepMs)
	}
}
