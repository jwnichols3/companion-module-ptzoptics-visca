import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { type CameraDefinition, CameraDefinitions, GenericVisca } from './index.js'
import { type PolledInquiry, PollGroups } from '../status/groups.js'
import type { Answer, AnswerParameters } from '../visca/inquiry.js'

/** One inquiry sent to a camera by `tools/capture-camera.mjs`, and its answer if one came. */
type CapturedExchange = {
	readonly sent: string
	readonly received: string | null
}

/** A capture, as much of it as a definition is checked against. */
type Capture = {
	readonly camera: { readonly brand: string; readonly model: string; readonly firmware: string | null }
} & (
	| { readonly state: 'on' | 'standby'; readonly exchanges: readonly CapturedExchange[] }
	| {
			readonly state: 'waking'
			readonly timeline: readonly { readonly atMs: number; readonly exchanges?: readonly CapturedExchange[] }[]
	  }
)

type ReadCapture = (name: string) => Capture | undefined

const CapturesDirectory = new URL('./captures/', import.meta.url)

function readCaptureFile(name: string): Capture | undefined {
	const file = new URL(`${name}.json`, CapturesDirectory)
	return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Capture) : undefined
}

const PolledInquiries = PollGroups.flatMap(({ inquiries }) => inquiries)

/** Write bytes the way a capture does (`90 50 02 FF`). */
function hex(bytes: readonly number[]): string {
	return bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ')
}

/** The answer in what a camera replied to a polled inquiry, or null if the reply isn't the inquiry's answer. */
function answerIn(received: string, { inquiry }: PolledInquiry): Answer<AnswerParameters> | null {
	const reply = received.split(' ').map((byte) => parseInt(byte, 16))
	const { bytes, mask, params } = inquiry.answer()
	if (reply.length !== bytes.length || !reply.every((byte, i) => (byte & mask[i]) === bytes[i])) {
		return null
	}

	const nibble = (n: number) => (n % 2 === 1 ? reply[n >> 1] & 0x0f : reply[n >> 1] >> 4)
	return Object.fromEntries(
		Object.entries(params).map(([id, { nibbles }]) => [id, nibbles.reduce((value, n) => (value << 4) | nibble(n), 0)]),
	)
}

/**
 * What a pass of a capture shows of a polled inquiry: its answer, or how the
 * camera failed to answer it.  The exchange is found by the bytes sent, as
 * captures name exchanges in their own way.
 */
function shownOf(polled: PolledInquiry, exchanges: readonly CapturedExchange[]): Answer<AnswerParameters> | string {
	const exchange = exchanges.find(({ sent }) => sent === hex(polled.inquiry.toBytes()))
	if (exchange === undefined) {
		return "the camera wasn't asked it"
	}
	if (exchange.received === null) {
		return 'the camera left it unanswered'
	}
	return answerIn(exchange.received, polled) ?? `the camera refused it (${exchange.received})`
}

/**
 * Every way the definition disagrees with the captures it names, in words: no
 * disagreements if there are none.
 *
 * A definition is what the module believes of a camera, and a capture is what
 * the camera did.  The definition must claim no more than its captures show:
 *
 *  - Every inquiry it names is one the module polls, and every capture it
 *    names exists, of one camera model.
 *  - It's backed by captures of the camera on and in standby, each giving the
 *    camera's model and firmware.  (Only Generic VISCA, which describes no
 *    one camera, has no captures.)
 *  - The camera answered every inquiry marked supported while on, and every
 *    inquiry of the standby set while in standby.
 *  - No zoom position captured is beyond the full-telephoto position.
 *  - The camera answered again, after Power On, within the wake window.
 */
function disagreements(definition: CameraDefinition, readCapture: ReadCapture = readCaptureFile): string[] {
	const found: string[] = []

	const polledInquiry = (id: string) => PolledInquiries.find((polled) => polled.id === id)
	for (const [list, ids] of [
		['supported', definition.supported],
		['answered in standby', definition.standby],
	] as const) {
		for (const id of ids) {
			if (polledInquiry(id) === undefined) {
				found.push(`"${id}", listed as ${list}, isn't an inquiry the module polls`)
			}
		}
	}
	for (const id of definition.standby) {
		if (!definition.supported.includes(id)) {
			found.push(`"${id}" is listed as answered in standby but not as supported`)
		}
	}

	const captures: { readonly name: string; readonly capture: Capture }[] = []
	for (const name of new Set([...definition.captures, ...definition.quirks.map(({ capture }) => capture)])) {
		const capture = readCapture(name)
		if (capture === undefined) {
			found.push(`names the capture "${name}", which doesn't exist`)
			continue
		}
		captures.push({ name, capture })

		const { model, firmware } = capture.camera
		if (model === '') found.push(`${name} doesn't give the camera's model`)
		if (firmware === null || firmware === '') found.push(`${name} doesn't give the camera's firmware`)
	}
	for (const { name } of definition.quirks) {
		if (!definition.captures.includes(name)) {
			found.push(`the capture "${name}" shows a quirk but isn't among the captures`)
		}
	}

	const models = new Set(captures.map(({ capture: { camera } }) => `${camera.brand} ${camera.model}`))
	if (models.size > 1) {
		found.push(`names captures of more than one camera model: ${[...models].join(', ')}`)
	}
	if (definition.id !== GenericVisca.id) {
		for (const state of ['on', 'standby'] as const) {
			if (!captures.some(({ capture }) => capture.state === state)) {
				found.push(`names no capture of the camera ${state === 'on' ? 'on' : 'in standby'}`)
			}
		}
	}

	for (const { name, capture } of captures) {
		const passes =
			capture.state === 'waking'
				? capture.timeline.flatMap(({ exchanges }) => (exchanges === undefined ? [] : [exchanges]))
				: [capture.exchanges]

		if (capture.state !== 'waking') {
			const [ids, claim] =
				capture.state === 'on'
					? [definition.supported, 'is marked supported']
					: [definition.standby, 'is listed as answered in standby']
			for (const id of ids) {
				const polled = polledInquiry(id)
				if (polled === undefined) continue
				const shown = shownOf(polled, capture.exchanges)
				if (typeof shown === 'string') {
					found.push(`"${id}" ${claim}, but ${name} shows ${shown}`)
				}
			}
		}

		const zoom = polledInquiry('zoom')
		if (zoom !== undefined) {
			const { zoomMax } = definition.ranges
			for (const exchanges of passes) {
				const shown = shownOf(zoom, exchanges)
				if (typeof shown === 'string') continue
				const { zoom: position } = zoom.toValues(shown, { zoomMax })
				if (Number(position) > zoomMax) {
					found.push(`the full-telephoto zoom position is ${zoomMax}, but ${name} shows the zoom position ${position}`)
					break
				}
			}
		}

		if (capture.state === 'waking') {
			const answeredAt = capture.timeline.find(({ exchanges = [] }) =>
				exchanges.some(({ received }) => received !== null),
			)?.atMs
			if (answeredAt === undefined) {
				found.push(`${name} doesn't show the camera answering again`)
			} else if (answeredAt > definition.wakeWindowMs) {
				found.push(
					`the wake window is ${definition.wakeWindowMs} ms, but ${name} shows the camera first answering ` +
						`${answeredAt} ms after Power On`,
				)
			}
		}
	}

	return found
}

describe.each(CameraDefinitions)('camera definition agrees with its captures: $label', (definition) => {
	test('nothing the definition says is contradicted by a capture', () => {
		expect(disagreements(definition)).toEqual([])
	})
})

describe('a camera definition that disagrees with its captures is told how', () => {
	// The built-in definition with captures, so that what's wrong below is
	// worked out from its captures and not copied from them.
	const backed = CameraDefinitions.find(({ captures }) => captures.length > 0)
	if (backed === undefined) {
		throw new Error('No built-in camera definition has captures')
	}

	const captureOf = (state: Capture['state']) => {
		for (const name of backed.captures) {
			const capture = readCaptureFile(name)
			if (capture?.state === state) return { name, capture }
		}
		throw new Error(`${backed.label} has no capture of the camera ${state}`)
	}

	/** The capture of the given state with one inquiry answered differently, under another name. */
	const captureAnswering = (state: 'on' | 'standby', id: string, received: string | null): ReadCapture => {
		const { capture } = captureOf(state)
		const polled = PolledInquiries.find((p) => p.id === id)
		if (capture.state === 'waking' || polled === undefined) throw new Error(`No "${id}" in a capture of ${state}`)
		const sent = hex(polled.inquiry.toBytes())
		const changed: Capture = {
			...capture,
			exchanges: capture.exchanges.map((exchange) => (exchange.sent === sent ? { sent, received } : exchange)),
		}
		return (name) => (name === `changed/${state}` ? changed : readCaptureFile(name))
	}

	test('the definition itself is in agreement', () => {
		expect(disagreements(backed)).toEqual([])
	})

	test('an inquiry marked supported that a capture shows refused', () => {
		const [id] = backed.supported.filter((supported) => supported !== 'power')
		const { name } = captureOf('on')
		const captures = backed.captures.map((capture) => (capture === name ? 'changed/on' : capture))

		expect(disagreements({ ...backed, captures }, captureAnswering('on', id, '90 60 02 FF'))).toEqual([
			`"${id}" is marked supported, but changed/on shows the camera refused it (90 60 02 FF)`,
		])
	})

	test('an inquiry marked supported that a capture shows unanswered', () => {
		const [id] = backed.supported.filter((supported) => supported !== 'power')
		const { name } = captureOf('on')
		const captures = backed.captures.map((capture) => (capture === name ? 'changed/on' : capture))

		expect(disagreements({ ...backed, captures }, captureAnswering('on', id, null))).toEqual([
			`"${id}" is marked supported, but changed/on shows the camera left it unanswered`,
		])
	})

	test('a standby set that a capture contradicts', () => {
		const id = 'zoom'
		const { name } = captureOf('standby')
		const captures = backed.captures.map((capture) => (capture === name ? 'changed/standby' : capture))
		const definition = { ...backed, standby: [...new Set([...backed.standby, id])], captures }

		expect(disagreements(definition, captureAnswering('standby', id, '90 61 41 FF'))).toEqual([
			`"${id}" is listed as answered in standby, but changed/standby shows the camera refused it (90 61 41 FF)`,
		])
	})

	test('a zoom range that a captured position exceeds', () => {
		const { name, capture } = captureOf('on')
		const zoom = PolledInquiries.find(({ id }) => id === 'zoom')
		if (capture.state === 'waking' || zoom === undefined) throw new Error('No zoom position captured')
		const shown = shownOf(zoom, capture.exchanges)
		if (typeof shown === 'string') throw new Error('No zoom position captured')
		const position = Number(zoom.toValues(shown, { zoomMax: 0 })['zoom'])

		expect(disagreements({ ...backed, ranges: { zoomMax: position - 1 } })).toContain(
			`the full-telephoto zoom position is ${position - 1}, but ${name} shows the zoom position ${position}`,
		)
		expect(disagreements({ ...backed, ranges: { zoomMax: position } })).toEqual(
			disagreements({ ...backed, ranges: { zoomMax: 0xffff } }),
		)
	})

	test('a wake window shorter than the camera was captured taking to answer again', () => {
		const { name, capture } = captureOf('waking')
		if (capture.state !== 'waking') throw new Error('Not a capture of the camera waking')
		const answeredAt = capture.timeline.find(({ exchanges = [] }) =>
			exchanges.some(({ received }) => received !== null),
		)?.atMs
		if (answeredAt === undefined) throw new Error('The camera was never captured answering again')

		expect(disagreements({ ...backed, wakeWindowMs: answeredAt - 1 })).toEqual([
			`the wake window is ${answeredAt - 1} ms, but ${name} shows the camera first answering ` +
				`${answeredAt} ms after Power On`,
		])
		expect(disagreements({ ...backed, wakeWindowMs: answeredAt })).toEqual([])
	})

	test('an inquiry that the module does not poll', () => {
		expect(disagreements({ ...backed, supported: [...backed.supported, 'no-such-inquiry'] })).toEqual([
			'"no-such-inquiry", listed as supported, isn\'t an inquiry the module polls',
		])
		expect(disagreements({ ...GenericVisca, standby: ['no-such-inquiry'] })).toEqual([
			'"no-such-inquiry", listed as answered in standby, isn\'t an inquiry the module polls',
			'"no-such-inquiry" is listed as answered in standby but not as supported',
		])
	})

	test('a capture that does not exist', () => {
		expect(disagreements({ ...backed, captures: [...backed.captures, 'no-such-camera/on'] })).toEqual([
			'names the capture "no-such-camera/on", which doesn\'t exist',
		])
	})

	test('no capture of the camera on, or in standby, or no model or firmware in one', () => {
		expect(disagreements({ ...backed, id: 'test-camera', captures: [] })).toEqual([
			'names no capture of the camera on',
			'names no capture of the camera in standby',
		])

		const { name, capture } = captureOf('on')
		const anonymous: Capture = { ...capture, camera: { ...capture.camera, firmware: null } }
		expect(disagreements(backed, (n) => (n === name ? anonymous : readCaptureFile(n)))).toEqual([
			`${name} doesn't give the camera's firmware`,
		])
	})
})
