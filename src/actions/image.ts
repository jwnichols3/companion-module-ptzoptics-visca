import type { ActionDefinitions } from './actionid.js'
import { ImageSettingId, ImageSettings, PanTiltRelative, SaveImageSettings } from '../camera/image.js'
import type { PtzOpticsInstance } from '../instance.js'

export const ImageActionId = {
	ImageAdjust: 'imageAdjust',
	ImageSave: 'imageSave',
	PanTiltStep: 'panTiltStep',
} as const

export type ImageActionId = (typeof ImageActionId)[keyof typeof ImageActionId]

const ImageSettingChoices = ImageSettings.map(({ id, label }) => ({ id, label }))

export function imageActions(instance: PtzOpticsInstance): ActionDefinitions<ImageActionId> {
	return {
		[ImageActionId.ImageAdjust]: {
			name: 'Image: adjust setting (for knobs)',
			description:
				'Step a color or picture setting up or down, set it, or reset it.  Steps need "Poll camera status" ' +
				'with "Color and picture" (and "White balance" for red/blue gain) on, to know the current value.',
			options: [
				{
					type: 'dropdown',
					id: 'setting',
					label: 'Setting',
					choices: ImageSettingChoices,
					default: ImageSettingId.ColorTemperature,
				},
				{
					type: 'dropdown',
					id: 'op',
					label: 'Change',
					choices: [
						{ id: 'up', label: 'Up by step' },
						{ id: 'down', label: 'Down by step' },
						{ id: 'set', label: 'Set to raw value' },
						{ id: 'reset', label: 'Reset to default' },
					],
					default: 'up',
				},
				{ type: 'number', id: 'amount', label: 'Step or value (raw)', default: 1, min: 0, max: 255 },
				{
					type: 'checkbox',
					id: 'setWhiteBalance',
					label: 'Switch white balance mode first if the setting needs it (color temp, red/blue gain)',
					default: true,
				},
			],
			callback: async ({ options }) => {
				const amount = Number(options['amount'])
				const op = String(options['op'])
				instance.imageAdjust(
					String(options['setting']),
					op === 'up' || op === 'down'
						? { delta: op === 'down' ? -amount : amount }
						: op === 'set'
							? { value: amount }
							: { reset: true },
					Boolean(options['setWhiteBalance']),
				)
			},
		},
		[ImageActionId.ImageSave]: {
			name: 'Image: save settings to camera',
			description: 'Store the current picture settings so they survive a power cycle (81 01 04 A5 10 FF).',
			options: [],
			callback: async () => {
				instance.sendCommand(SaveImageSettings)
			},
		},
		[ImageActionId.PanTiltStep]: {
			name: 'Pan/tilt: fine step (for knobs)',
			description: 'Move pan or tilt by a small fixed amount (relative move).',
			options: [
				{
					type: 'dropdown',
					id: 'axis',
					label: 'Axis',
					choices: [
						{ id: 'pan', label: 'Pan' },
						{ id: 'tilt', label: 'Tilt' },
					],
					default: 'pan',
				},
				{ type: 'number', id: 'steps', label: 'Steps (signed camera units)', default: 8, min: -500, max: 500 },
				{ type: 'number', id: 'speed', label: 'Speed (1-24)', default: 16, min: 1, max: 24 },
			],
			callback: async ({ options }) => {
				const steps = Math.round(Number(options['steps']))
				const speed = Math.min(24, Math.max(1, Math.round(Number(options['speed']))))
				const pan = options['axis'] === 'tilt' ? 0 : steps
				const tilt = options['axis'] === 'tilt' ? steps : 0
				instance.sendCommand(PanTiltRelative, { panSpeed: speed, tiltSpeed: Math.min(20, speed), pan, tilt })
			},
		},
	}
}
