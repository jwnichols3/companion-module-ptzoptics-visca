import type { CompanionFeedbackDefinitions, CompanionVariableValue, DropdownChoice } from '@companion-module/base'
import { ImageSettings, imageSetting } from '../camera/image.js'
import { Amber, Black, Green, Grey, LightGrey, Red, White } from '../utils/colors.js'

/** Read-only access to the latest status the module knows. */
export interface StatusSource {
	statusValue(id: string): CompanionVariableValue | undefined
	/** False when polling is on but the last poll got no answers. */
	readonly statusFresh: boolean
}

export const FeedbackId = {
	Power: 'statusPower',
	FocusMode: 'statusFocusMode',
	ExposureMode: 'statusExposureMode',
	WhiteBalanceMode: 'statusWhiteBalanceMode',
	ImageFlag: 'statusImageFlag',
	Zoom: 'statusZoom',
	Speed: 'statusSpeed',
	Moving: 'statusMoving',
	AutoTracking: 'statusAutoTracking',
	LastPreset: 'statusLastPreset',
	Stale: 'statusStale',
	ImageOffDefault: 'statusImageOffDefault',
} as const

const exposureModes: DropdownChoice[] = [
	{ id: 'full-auto', label: 'Full auto' },
	{ id: 'manual', label: 'Manual' },
	{ id: 'shutter-priority', label: 'Shutter priority' },
	{ id: 'iris-priority', label: 'Iris priority' },
	{ id: 'bright', label: 'Bright' },
]

const whiteBalanceModes: DropdownChoice[] = [
	{ id: 'auto', label: 'Auto' },
	{ id: 'indoor', label: 'Indoor' },
	{ id: 'outdoor', label: 'Outdoor' },
	{ id: 'one-push', label: 'One push' },
	{ id: 'manual', label: 'Manual' },
	{ id: 'color-temp', label: 'Color temperature (VAR)' },
]

const comparisons: DropdownChoice[] = [
	{ id: 'eq', label: 'equal to' },
	{ id: 'gt', label: 'above' },
	{ id: 'lt', label: 'below' },
]

function compare(value: CompanionVariableValue | undefined, op: unknown, target: unknown): boolean {
	if (typeof value !== 'number') return false
	const t = Number(target)
	switch (op) {
		case 'gt':
			return value > t
		case 'lt':
			return value < t
		default:
			return value === t
	}
}

const needsPolling = 'Needs "Poll camera status" on in the connection settings.'
const needsWeb = 'Needs "Read status from the camera web interface" on in the connection settings.'

export function getFeedbacks(src: StatusSource): CompanionFeedbackDefinitions {
	const is = (id: string, expected: unknown) => src.statusValue(id) === expected

	return {
		[FeedbackId.Power]: {
			type: 'boolean',
			name: 'Camera: power is on',
			description: needsPolling,
			defaultStyle: { bgcolor: Green, color: White },
			options: [],
			callback: () => is('power', 'on'),
		},
		[FeedbackId.FocusMode]: {
			type: 'boolean',
			name: 'Lens: focus mode is',
			description: needsPolling,
			defaultStyle: { bgcolor: Amber, color: Black },
			options: [
				{
					type: 'dropdown',
					id: 'mode',
					label: 'Mode',
					choices: [
						{ id: 'auto', label: 'Auto focus' },
						{ id: 'manual', label: 'Manual focus' },
					],
					default: 'manual',
				},
			],
			callback: ({ options }) => is('focus_mode', options['mode']),
		},
		[FeedbackId.ExposureMode]: {
			type: 'boolean',
			name: 'Exposure: mode is',
			description: needsPolling + ' (Exposure group)',
			defaultStyle: { bgcolor: Green, color: White },
			options: [{ type: 'dropdown', id: 'mode', label: 'Mode', choices: exposureModes, default: 'full-auto' }],
			callback: ({ options }) => is('exposure_mode', options['mode']),
		},
		[FeedbackId.WhiteBalanceMode]: {
			type: 'boolean',
			name: 'White balance: mode is',
			description: needsPolling + ' (White balance group)',
			defaultStyle: { bgcolor: Green, color: White },
			options: [{ type: 'dropdown', id: 'mode', label: 'Mode', choices: whiteBalanceModes, default: 'auto' }],
			callback: ({ options }) => is('wb_mode', options['mode']),
		},
		[FeedbackId.ImageFlag]: {
			type: 'boolean',
			name: 'Image: flip or mirror is on',
			description: needsPolling + ' (Image group)',
			defaultStyle: { bgcolor: Amber, color: Black },
			options: [
				{
					type: 'dropdown',
					id: 'which',
					label: 'Setting',
					choices: [
						{ id: 'flip', label: 'Flip' },
						{ id: 'mirror', label: 'Mirror' },
					],
					default: 'flip',
				},
			],
			callback: ({ options }) => is(String(options['which']), 'on'),
		},
		[FeedbackId.Zoom]: {
			type: 'boolean',
			name: 'Lens: zoom position (%)',
			description: needsPolling + ' 0% is full wide, 100% full telephoto.',
			defaultStyle: { bgcolor: Amber, color: Black },
			options: [
				{ type: 'dropdown', id: 'op', label: 'Zoom is', choices: comparisons, default: 'gt' },
				{ type: 'number', id: 'percent', label: 'Percent', default: 80, min: 0, max: 100 },
			],
			callback: ({ options }) => compare(src.statusValue('zoom_pct'), options['op'], options['percent']),
		},
		[FeedbackId.Speed]: {
			type: 'boolean',
			name: 'Pan/tilt: speed is',
			defaultStyle: { bgcolor: Amber, color: Black },
			options: [
				{ type: 'dropdown', id: 'op', label: 'Speed is', choices: comparisons, default: 'eq' },
				{ type: 'number', id: 'speed', label: 'Speed (1-24)', default: 12, min: 1, max: 24 },
			],
			callback: ({ options }) => compare(src.statusValue('pt_speed'), options['op'], options['speed']),
		},
		[FeedbackId.Moving]: {
			type: 'boolean',
			name: 'Camera: is moving',
			description: needsWeb,
			defaultStyle: { bgcolor: Red, color: White },
			options: [
				{
					type: 'dropdown',
					id: 'axis',
					label: 'Moving',
					choices: [
						{ id: 'moving', label: 'Anything' },
						{ id: 'pt_moving', label: 'Pan/tilt' },
						{ id: 'zoom_moving', label: 'Zoom' },
						{ id: 'focus_moving', label: 'Focus' },
					],
					default: 'moving',
				},
			],
			callback: ({ options }) => is(String(options['axis']), 'true'),
		},
		[FeedbackId.AutoTracking]: {
			type: 'boolean',
			name: 'Camera: auto-tracking is on',
			description: needsWeb,
			defaultStyle: { bgcolor: Green, color: White },
			options: [],
			callback: () => is('autotrack', 'on'),
		},
		[FeedbackId.LastPreset]: {
			type: 'boolean',
			name: 'Presets: preset is the one last recalled',
			description:
				'On after this module recalls the preset. Turns off when the camera is moved away from it ' +
				'(detected with "Pan/tilt position" and "Zoom and focus" polling) or another preset is recalled.',
			defaultStyle: { bgcolor: Red, color: White },
			options: [{ type: 'number', id: 'preset', label: 'Preset number', default: 1, min: 0, max: 254 }],
			callback: ({ options }) => src.statusValue('last_preset') === Number(options['preset']),
		},
		[FeedbackId.Stale]: {
			type: 'boolean',
			name: 'Camera: status is not updating',
			description: 'On when polling is on but the camera stopped answering.',
			defaultStyle: { bgcolor: Grey, color: LightGrey },
			options: [],
			callback: () => !src.statusFresh,
		},
		[FeedbackId.ImageOffDefault]: {
			type: 'boolean',
			name: 'Image: setting differs from its default',
			description: needsPolling + ' (Color and picture group, or White balance for red/blue gain)',
			defaultStyle: { bgcolor: Amber, color: Black },
			options: [
				{
					type: 'dropdown',
					id: 'setting',
					label: 'Setting',
					choices: ImageSettings.map(({ id, label }) => ({ id, label })),
					default: 'redTuning',
				},
			],
			callback: ({ options }) => {
				const setting = imageSetting(options['setting'])
				if (setting === undefined) return false
				const v = src.statusValue(setting.variable)
				return typeof v === 'number' && v !== setting.center
			},
		},
	}
}
