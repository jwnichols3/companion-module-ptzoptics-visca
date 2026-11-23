import type { CompanionVariableDefinition, CompanionVariableValues, DropdownChoice } from '@companion-module/base'
import { ImageSettings } from '../camera/image.js'
import { type Answer, type AnswerParameters, type Inquiry, UserDefinedInquiry } from '../visca/inquiry.js'

/**
 * One inquiry that the status poller sends, and how to turn its answer into
 * variable values.
 *
 * Polled inquiries are constructed as `UserDefinedInquiry` so that a camera
 * that doesn't support one of them (answering with a syntax error, or with an
 * answer of unexpected format) only fails that inquiry, rather than failing
 * the whole connection as an error in a module-defined inquiry would.
 */
export type PolledInquiry = {
	/** A short id, used in log messages. */
	readonly id: string
	readonly inquiry: Inquiry<AnswerParameters>
	readonly toValues: (answer: Answer<AnswerParameters>, ctx: PollContext) => CompanionVariableValues
}

/** Per-connection settings that affect how answers are converted. */
export type PollContext = {
	/** The zoom position of the telephoto end, used to compute `zoom_pct`. */
	readonly zoomMax: number
}

/** A user-selectable group of related inquiries. */
type PollGroup = {
	readonly id: PollGroupId
	readonly label: string
	readonly inquiries: readonly PolledInquiry[]
	readonly variables: readonly CompanionVariableDefinition[]
}

export const PollGroupId = {
	Power: 'power',
	Position: 'position',
	Lens: 'lens',
	Exposure: 'exposure',
	WhiteBalance: 'white-balance',
	Image: 'image',
	Picture: 'picture',
} as const

export type PollGroupId = (typeof PollGroupId)[keyof typeof PollGroupId]

/** Interpret a 16-bit value as two's-complement signed. */
function signed16(v: number): number {
	return v & 0x8000 ? v - 0x10000 : v
}

/** Answer `90 50 0p FF`, one nibble parameter. */
function oneNibble(bytes: number[]): UserDefinedInquiry<{ p: { nibbles: [5] } }> {
	return new UserDefinedInquiry(bytes, { bytes: [0x90, 0x50, 0x00, 0xff], params: { p: { nibbles: [5] } } })
}

/** Answer `90 50 pq FF`, one whole-byte parameter. */
function oneByte(bytes: number[]): UserDefinedInquiry<{ p: { nibbles: [4, 5] } }> {
	return new UserDefinedInquiry(bytes, { bytes: [0x90, 0x50, 0x00, 0xff], params: { p: { nibbles: [4, 5] } } })
}

/** Answer `90 50 0p 0q 0r 0s FF`, one 16-bit parameter. */
function fourNibbles(bytes: number[]): UserDefinedInquiry<{ p: { nibbles: [5, 7, 9, 11] } }> {
	return new UserDefinedInquiry(bytes, {
		bytes: [0x90, 0x50, 0x00, 0x00, 0x00, 0x00, 0xff],
		params: { p: { nibbles: [5, 7, 9, 11] } },
	})
}

/** Answer `90 50 00 00 0p 0q FF`, one 8-bit parameter. */
function twoLowNibbles(bytes: number[]): UserDefinedInquiry<{ p: { nibbles: [9, 11] } }> {
	return new UserDefinedInquiry(bytes, {
		bytes: [0x90, 0x50, 0x00, 0x00, 0x00, 0x00, 0xff],
		params: { p: { nibbles: [9, 11] } },
	})
}

/** On/off answers encode on as 2 and off as 3. */
function onOff(p: number): string {
	return p === 2 ? 'on' : p === 3 ? 'off' : `unknown (${p})`
}

function lookup(table: Record<number, string>, p: number): string {
	return table[p] ?? `unknown (${p})`
}

const ExposureModes: Record<number, string> = {
	0x0: 'full-auto',
	0x3: 'manual',
	0xa: 'shutter-priority',
	0xb: 'iris-priority',
	0xd: 'bright',
}

const WhiteBalanceModes: Record<number, string> = {
	0x0: 'auto',
	0x1: 'indoor',
	0x2: 'outdoor',
	0x3: 'one-push',
	0x5: 'manual',
	0x20: 'color-temp',
}

export const PollGroups: PollGroup[] = [
	{
		id: PollGroupId.Power,
		label: 'Power',
		inquiries: [
			{
				id: 'power',
				inquiry: oneNibble([0x81, 0x09, 0x04, 0x00, 0xff]),
				toValues: ({ p }) => ({ power: p === 2 ? 'on' : p === 3 ? 'standby' : `unknown (${p})` }),
			},
		],
		variables: [{ variableId: 'power', name: 'Power (on, standby)' }],
	},
	{
		id: PollGroupId.Position,
		label: 'Pan/tilt position',
		inquiries: [
			{
				id: 'pan-tilt',
				inquiry: new UserDefinedInquiry([0x81, 0x09, 0x06, 0x12, 0xff], {
					bytes: [0x90, 0x50, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff],
					params: { pan: { nibbles: [5, 7, 9, 11] }, tilt: { nibbles: [13, 15, 17, 19] } },
				}),
				toValues: ({ pan, tilt }) => ({ pan: signed16(pan), tilt: signed16(tilt) }),
			},
		],
		variables: [
			{ variableId: 'pan', name: 'Pan position (camera units, signed)' },
			{ variableId: 'tilt', name: 'Tilt position (camera units, signed)' },
		],
	},
	{
		id: PollGroupId.Lens,
		label: 'Zoom and focus',
		inquiries: [
			{
				id: 'zoom',
				inquiry: fourNibbles([0x81, 0x09, 0x04, 0x47, 0xff]),
				toValues: ({ p }, { zoomMax }) => ({
					zoom: p,
					zoom_pct: Math.max(0, Math.min(100, Math.round((100 * p) / zoomMax))),
				}),
			},
			{
				id: 'focus',
				inquiry: fourNibbles([0x81, 0x09, 0x04, 0x48, 0xff]),
				toValues: ({ p }) => ({ focus: p }),
			},
			{
				id: 'focus-mode',
				inquiry: oneNibble([0x81, 0x09, 0x04, 0x38, 0xff]),
				toValues: ({ p }) => ({ focus_mode: p === 2 ? 'auto' : p === 3 ? 'manual' : `unknown (${p})` }),
			},
		],
		variables: [
			{ variableId: 'zoom', name: 'Zoom position (raw)' },
			{ variableId: 'zoom_pct', name: 'Zoom position (0-100%, wide to tele)' },
			{ variableId: 'focus', name: 'Focus position (raw)' },
			{ variableId: 'focus_mode', name: 'Focus mode (auto, manual)' },
		],
	},
	{
		id: PollGroupId.Exposure,
		label: 'Exposure',
		inquiries: [
			{
				id: 'exposure-mode',
				inquiry: oneNibble([0x81, 0x09, 0x04, 0x39, 0xff]),
				toValues: ({ p }) => ({ exposure_mode: lookup(ExposureModes, p) }),
			},
			{ id: 'iris', inquiry: twoLowNibbles([0x81, 0x09, 0x04, 0x4b, 0xff]), toValues: ({ p }) => ({ iris: p }) },
			{
				id: 'shutter',
				inquiry: twoLowNibbles([0x81, 0x09, 0x04, 0x4a, 0xff]),
				toValues: ({ p }) => ({ shutter: p }),
			},
			{ id: 'gain', inquiry: twoLowNibbles([0x81, 0x09, 0x04, 0x4c, 0xff]), toValues: ({ p }) => ({ gain: p }) },
			{
				id: 'brightness',
				inquiry: twoLowNibbles([0x81, 0x09, 0x04, 0x4d, 0xff]),
				toValues: ({ p }) => ({ brightness: p }),
			},
		],
		variables: [
			{ variableId: 'exposure_mode', name: 'Exposure mode' },
			{ variableId: 'iris', name: 'Iris position (raw)' },
			{ variableId: 'shutter', name: 'Shutter position (raw)' },
			{ variableId: 'gain', name: 'Gain position (raw)' },
			{ variableId: 'brightness', name: 'Brightness position (raw)' },
		],
	},
	{
		id: PollGroupId.WhiteBalance,
		label: 'White balance',
		inquiries: [
			{
				id: 'wb-mode',
				// Color temperature mode answers 90 50 20 FF, so read the whole byte.
				inquiry: oneByte([0x81, 0x09, 0x04, 0x35, 0xff]),
				toValues: ({ p }) => ({ wb_mode: lookup(WhiteBalanceModes, p) }),
			},
			{
				id: 'wb-red',
				inquiry: twoLowNibbles([0x81, 0x09, 0x04, 0x43, 0xff]),
				toValues: ({ p }) => ({ wb_red: p }),
			},
			{
				id: 'wb-blue',
				inquiry: twoLowNibbles([0x81, 0x09, 0x04, 0x44, 0xff]),
				toValues: ({ p }) => ({ wb_blue: p }),
			},
		],
		variables: [
			{ variableId: 'wb_mode', name: 'White balance mode (auto, indoor, outdoor, one-push, manual, color-temp)' },
			{ variableId: 'wb_red', name: 'White balance red gain (raw)' },
			{ variableId: 'wb_blue', name: 'White balance blue gain (raw)' },
		],
	},
	{
		id: PollGroupId.Image,
		label: 'Image flip and mirror',
		inquiries: [
			{ id: 'flip', inquiry: oneNibble([0x81, 0x09, 0x04, 0x66, 0xff]), toValues: ({ p }) => ({ flip: onOff(p) }) },
			{
				id: 'mirror',
				inquiry: oneNibble([0x81, 0x09, 0x04, 0x61, 0xff]),
				toValues: ({ p }) => ({ mirror: onOff(p) }),
			},
		],
		variables: [
			{ variableId: 'flip', name: 'Image flip (on, off)' },
			{ variableId: 'mirror', name: 'Image mirror (on, off)' },
		],
	},
]

const PictureSettings = ImageSettings.filter((s) => s.variable !== 'wb_red' && s.variable !== 'wb_blue')

PollGroups.push({
	id: PollGroupId.Picture,
	label: 'Color and picture (color temp, tuning, saturation, hue, contrast, brightness, sharpness, exp comp)',
	inquiries: PictureSettings.map((s) => {
		const bytes = [0x81, 0x09, ...s.inquiry, 0xff]
		return {
			id: s.variable,
			inquiry: s.byteAnswer === true ? oneByte(bytes) : twoLowNibbles(bytes),
			toValues: ({ p }: Answer<AnswerParameters>) => ({
				[s.variable]: p,
				[`${s.variable}_label`]: s.display(Number(p)),
			}),
		}
	}),
	variables: PictureSettings.flatMap((s) => [
		{ variableId: s.variable, name: `${s.label} (raw ${s.min}-${s.max})` },
		{ variableId: `${s.variable}_label`, name: `${s.label} (display)` },
	]),
})

export const DefaultPollGroups: PollGroupId[] = [PollGroupId.Power, PollGroupId.Position, PollGroupId.Lens]

export function pollGroupChoices(): DropdownChoice[] {
	return PollGroups.map(({ id, label }) => ({ id, label }))
}

export function isPollGroupId(id: unknown): id is PollGroupId {
	return PollGroups.some((g) => g.id === id)
}
