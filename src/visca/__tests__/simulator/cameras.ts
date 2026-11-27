import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { CommandNotExecutable, SyntaxErrorBytes } from '../camera-interactions/bytes.js'
import type { CameraReplies, WakeUpStep } from './simulated-camera.js'
import type { Bytes } from '../../../utils/byte.js'

export const PowerInquiryBytes = [0x81, 0x09, 0x04, 0x00, 0xff]
const PanTiltPositionInquiryBytes = [0x81, 0x09, 0x06, 0x12, 0xff]
const ZoomPositionInquiryBytes = [0x81, 0x09, 0x04, 0x47, 0xff]
const FocusPositionInquiryBytes = [0x81, 0x09, 0x04, 0x48, 0xff]
const FocusModeInquiryBytes = [0x81, 0x09, 0x04, 0x38, 0xff]

/** A camera the simulated camera can play. */
type Camera = {
	/** Names the camera on the command line of the simulated camera service. */
	readonly id: string
	/** Names the camera in test titles. */
	readonly name: string
	readonly replies: CameraReplies
}

/** One inquiry sent to a camera by `tools/capture-camera.mjs`, and its answer if one came. */
type CapturedExchange = {
	readonly name: string
	readonly sent: string
	readonly received: string | null
}

/** A capture of a camera that's on or in standby, as much of it as is used here. */
type StateCapture = {
	readonly scriptVersion: number
	readonly exchanges: readonly CapturedExchange[]
}

/** A capture of a camera waking from standby, as much of it as is used here. */
type WakingCapture = {
	readonly scriptVersion: number
	readonly timeline: readonly ({ readonly atMs: number } & (
		| { readonly exchanges: readonly CapturedExchange[] }
		| { readonly event: 'connected' }
		| { readonly event: 'connection-lost' }
		| { readonly event: 'unsolicited'; readonly received: readonly string[] }
	))[]
}

/**
 * The version of `tools/capture-camera.mjs` whose captures are understood
 * here, and how that version records a wake-up: it gives up on an inquiry
 * after `WakingReplyTimeoutMs`, makes a new connection at once, and after a
 * failed attempt to connect waits `WakingPassGapMs` before the next.
 */
const ScriptVersion = 1
const WakingReplyTimeoutMs = 2000
const WakingPassGapMs = 500

const CapturesDirectory = new URL('../../../cameras/captures/', import.meta.url)

/** Convert bytes written as in a capture (`90 50 02 FF`) to bytes. */
function bytes(hex: string): number[] {
	return hex.split(' ').map((byte) => parseInt(byte, 16))
}

function readCapture<Capture extends { readonly scriptVersion: number }>(file: URL): Capture {
	const capture = JSON.parse(readFileSync(file, 'utf8')) as Capture
	if (capture.scriptVersion !== ScriptVersion) {
		throw new Error(`${file.pathname} was written by version ${capture.scriptVersion} of the capture script`)
	}
	return capture
}

/**
 * How a camera answered the inquiries of one pass.  The capture script asks
 * only what the module can poll, so what the camera says to any other inquiry
 * wasn't recorded: assume a syntax error.
 */
function stateReplies(exchanges: readonly CapturedExchange[], file: URL): CameraReplies['on'] {
	return {
		replies: exchanges.map(({ name, sent, received }) => {
			if (received === null) {
				throw new Error(`${file.pathname}: no answer to "${name}", which the simulated camera can't yet play`)
			}
			return { inquiry: bytes(sent), reply: bytes(received) }
		}),
		otherwise: SyntaxErrorBytes,
	}
}

/**
 * Work out what a camera did as it woke from what the capture script saw.
 *
 * The script records what it did, and what came back, not what the camera
 * did, so some of this is inference:
 *
 *  - The camera stopped answering by the time of the first inquiry that went
 *    unanswered.
 *  - After an unanswered inquiry the script connects again at once.  If the
 *    new connection was made later than one failed attempt allows for, the
 *    camera wasn't accepting connections meanwhile.  The capture doesn't say
 *    how the attempts failed: assume they were refused.
 *  - The camera answered again from when the connection was made on which an
 *    answer first came.
 *  - Answers that nothing asked for came with the first answer.
 */
function wakeUpSteps({ timeline }: WakingCapture, file: URL): WakeUpStep[] {
	const steps: WakeUpStep[] = []

	let silent = false
	let refusing = false
	/** When the script gave up on its latest inquiry, if nothing has happened since. */
	let gaveUpAt: number | null = null
	/** When the latest connection was made, if nothing has been asked on it yet. */
	let connectedAt: number | null = null
	let unsolicited: Bytes = []

	for (const entry of timeline) {
		const { atMs } = entry
		if ('exchanges' in entry) {
			const answered = entry.exchanges.filter(({ received }) => received !== null)
			if (answered.length === 0) {
				if (!silent) {
					steps.push({ atMs, does: 'goes-silent' })
					silent = true
				}
				gaveUpAt = atMs + WakingReplyTimeoutMs
			} else {
				steps.push({
					atMs: silent ? (connectedAt ?? atMs) : atMs,
					does: 'answers',
					replies: stateReplies(entry.exchanges, file),
					unsolicited,
				})
				silent = false
				unsolicited = []
				gaveUpAt = null
			}
			connectedAt = null
			continue
		}

		switch (entry.event) {
			case 'connection-lost':
				steps.push({ atMs, does: 'drops-connection' }, { atMs, does: 'refuses-connections' })
				refusing = true
				break
			case 'connected':
				if (gaveUpAt !== null && atMs - gaveUpAt > WakingPassGapMs) {
					steps.push({ atMs: gaveUpAt, does: 'refuses-connections' })
					refusing = true
				}
				if (refusing) {
					steps.push({ atMs, does: 'accepts-connections' })
					refusing = false
				}
				connectedAt = atMs
				break
			case 'unsolicited':
				unsolicited = entry.received.flatMap(bytes)
				break
		}
		gaveUpAt = null
	}

	return steps
}

/**
 * The cameras that captures have been recorded from: one for each directory
 * of captures.  A camera needs captures of it on (`on.json`) and in standby
 * (`standby.json`); a capture of it waking (`waking.json`) is played back if
 * there is one, and otherwise the camera is on as soon as it's told to be.
 */
function capturedCameras(): Camera[] {
	return readdirSync(CapturesDirectory, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map(({ name }) => {
			const capture = (state: string) => new URL(`${name}/${state}.json`, CapturesDirectory)
			const on = capture('on')
			const standby = capture('standby')
			const waking = capture('waking')
			return {
				id: name,
				name: `${name} (captured)`,
				replies: {
					on: stateReplies(readCapture<StateCapture>(on).exchanges, on),
					standby: stateReplies(readCapture<StateCapture>(standby).exchanges, standby),
					...(existsSync(waking) ? { wakeUp: wakeUpSteps(readCapture<WakingCapture>(waking), waking) } : {}),
				},
			}
		})
}

/**
 * NOT A CAPTURE: written by hand from what was seen of PTZOptics cameras at
 * a church, powered on (2026-11-22) and in standby (2026-11-25), until
 * captures of those cameras take its place.
 *
 * Unlike the camera captured so far, these refuse every inquiry but power
 * while in standby, and that must stay covered.  They also lack answers to
 * all but a few inquiries, which stands in for a camera that doesn't support
 * them.  Nothing is known of how they wake, so this camera is on as soon as
 * it's told to be.
 */
export const HandWrittenCamera: Camera = {
	id: 'refuses-inquiries-in-standby',
	name: 'refuses inquiries in standby (hand-written, not captured)',
	replies: {
		on: {
			replies: [
				{ inquiry: PowerInquiryBytes, reply: [0x90, 0x50, 0x02, 0xff] },
				{
					inquiry: PanTiltPositionInquiryBytes,
					reply: [0x90, 0x50, 0x0f, 0x0d, 0x0d, 0x0f, 0x0f, 0x0f, 0x0b, 0x0c, 0xff],
				},
				{ inquiry: ZoomPositionInquiryBytes, reply: [0x90, 0x50, 0x02, 0x08, 0x0f, 0x07, 0xff] },
				{ inquiry: FocusPositionInquiryBytes, reply: [0x90, 0x50, 0x00, 0x07, 0x07, 0x02, 0xff] },
				{ inquiry: FocusModeInquiryBytes, reply: [0x90, 0x50, 0x02, 0xff] },
			],
			otherwise: SyntaxErrorBytes,
		},
		standby: {
			replies: [
				{ inquiry: PowerInquiryBytes, reply: [0x90, 0x50, 0x03, 0xff] },
				{ inquiry: PanTiltPositionInquiryBytes, reply: CommandNotExecutable(1) },
				{ inquiry: ZoomPositionInquiryBytes, reply: CommandNotExecutable(1) },
			],
			// Only the inquiries above were seen in standby.  Assume the camera
			// refuses every other inquiry the same way.
			otherwise: CommandNotExecutable(1),
		},
	},
}

/**
 * Every camera the simulated camera can play, for scenarios to run against
 * each: add a directory of captures and its camera is among them.
 */
export const Cameras: readonly Camera[] = [...capturedCameras(), HandWrittenCamera]
