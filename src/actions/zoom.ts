import type { CompanionActionEvent } from '@companion-module/base'
import type { ActionDefinitions } from './actionid.js'
import { ZoomIn, ZoomOut, ZoomStop } from '../camera/zoom.js'
import type { PtzOpticsInstance } from '../instance.js'

export const ZoomActionId = {
	StartZoomIn: 'zoomI',
	StartZoomOut: 'zoomO',
	StopZoom: 'zoomS',
	ZoomStep: 'zoomStep',
	ZoomToPercent: 'zoomToPercent',
} as const

export type ZoomActionId = (typeof ZoomActionId)[keyof typeof ZoomActionId]

export function zoomActions(instance: PtzOpticsInstance): ActionDefinitions<ZoomActionId> {
	return {
		[ZoomActionId.StartZoomIn]: {
			name: 'Zoom In',
			options: [],
			callback: async (_event: CompanionActionEvent) => {
				instance.sendCommand(ZoomIn)
			},
		},
		[ZoomActionId.StartZoomOut]: {
			name: 'Zoom Out',
			options: [],
			callback: async (_event: CompanionActionEvent) => {
				instance.sendCommand(ZoomOut)
			},
		},
		[ZoomActionId.StopZoom]: {
			name: 'Zoom Stop',
			options: [],
			callback: async (_event: CompanionActionEvent) => {
				instance.sendCommand(ZoomStop)
			},
		},
		[ZoomActionId.ZoomStep]: {
			name: 'Zoom step (for knobs)',
			description:
				'Zoom in or out by a percentage of the zoom range.  Needs "Poll camera status" with ' +
				'"Zoom and focus" on, to know where the zoom is.',
			options: [
				{
					type: 'dropdown',
					id: 'direction',
					label: 'Direction',
					choices: [
						{ id: 'in', label: 'In (tele)' },
						{ id: 'out', label: 'Out (wide)' },
					],
					default: 'in',
				},
				{ type: 'number', id: 'percent', label: 'Step (%)', default: 3, min: 1, max: 100 },
			],
			callback: async ({ options }) => {
				const sign = options['direction'] === 'out' ? -1 : 1
				instance.zoomStep(sign * Number(options['percent']))
			},
		},
		[ZoomActionId.ZoomToPercent]: {
			name: 'Zoom to position (%)',
			description: '0% is full wide, 100% full telephoto.',
			options: [{ type: 'number', id: 'percent', label: 'Position (%)', default: 0, min: 0, max: 100 }],
			callback: async ({ options }) => {
				instance.zoomToPercent(Number(options['percent']))
			},
		},
	}
}
