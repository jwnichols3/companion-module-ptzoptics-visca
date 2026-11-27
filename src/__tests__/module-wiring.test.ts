import { InstanceStatus } from '@companion-module/base'
import net from 'node:net'
import { describe, expect, test, vi } from 'vitest'
import { PanTiltActionId } from '../actions/pan-tilt.js'
import { ModuleUnderTest } from './module-under-test.js'
import { PollGroupId } from '../status/groups.js'

const PowerInquiryBytes = [0x81, 0x09, 0x04, 0x00, 0xff]
const PowerOnAnswerBytes = [0x90, 0x50, 0x02, 0xff]

/**
 * Start a local TCP server acting as a powered-on camera that only answers
 * the power inquiry.
 */
async function startPoweredOnCamera(): Promise<{ server: net.Server; port: number }> {
	const server = net.createServer({ noDelay: true }, (socket: net.Socket) => {
		socket.on('data', (data: Buffer) => {
			if (data.equals(Buffer.from(PowerInquiryBytes))) {
				socket.write(new Uint8Array(PowerOnAnswerBytes))
			}
		})
	})

	return new Promise((resolve, reject) => {
		server.on('error', reject)
		// Let the OS choose an unused port.
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address()
			if (addr === null || typeof addr === 'string') {
				reject(new Error('unexpected server address'))
				return
			}
			resolve({ server, port: addr.port })
		})
	})
}

describe('whole module against a local camera', () => {
	test('powered-on camera answering the power inquiry', async () => {
		const { server, port } = await startPoweredOnCamera()

		const module = await ModuleUnderTest.start({
			host: '127.0.0.1',
			port: String(port),
			pollEnabled: true,
			pollInterval: 100,
			pollGroups: [PollGroupId.Power],
		})
		try {
			await vi.waitFor(() => {
				expect(module.variable('power')).toBe('on')
			})
			expect(module.status).toBe(InstanceStatus.Ok)

			expect(module.variable('pt_speed')).toBe(12)
			await module.executeAction(PanTiltActionId.SpeedUpMovement)
			expect(module.variable('pt_speed')).toBe(13)
		} finally {
			await module.destroy()
			server.close()
		}
	})
})
