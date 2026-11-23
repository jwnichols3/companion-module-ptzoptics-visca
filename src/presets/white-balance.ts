import type { CompanionPresetDefinitions } from '@companion-module/base'
import { WhiteBalanceActionId, WhiteBalanceModeId } from '../actions/white-balance.js'
import { FeedbackId } from '../feedbacks/feedbacks.js'
import { Black, White } from '../utils/colors.js'

export function whiteBalancePresets(): CompanionPresetDefinitions {
	return {
		auto_white_balance_preset: {
			type: 'button',
			category: 'White balance',
			name: 'Auto White Balance',
			style: {
				text: 'WB\\nAUTO',
				size: '14',
				color: White,
				bgcolor: Black,
			},
			steps: [
				{
					down: [
						{
							actionId: WhiteBalanceActionId.SelectWhiteBalance,
							options: {
								[WhiteBalanceModeId]: 'automatic',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [{ feedbackId: FeedbackId.WhiteBalanceMode, options: { mode: 'auto' } }],
		},

		indoor_white_balance_preset: {
			type: 'button',
			category: 'White balance',
			name: 'Indoor White Balance',
			style: {
				text: 'WB\\nINDOOR',
				size: '14',
				color: White,
				bgcolor: Black,
			},
			steps: [
				{
					down: [
						{
							actionId: WhiteBalanceActionId.SelectWhiteBalance,
							options: {
								[WhiteBalanceModeId]: 'indoor',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [{ feedbackId: FeedbackId.WhiteBalanceMode, options: { mode: 'indoor' } }],
		},

		outdoor_white_balance_preset: {
			type: 'button',
			category: 'White balance',
			name: 'Outdoor White Balance',
			style: {
				text: 'WB\\nOUT\\nDOOR',
				size: '14',
				color: White,
				bgcolor: Black,
			},
			steps: [
				{
					down: [
						{
							actionId: WhiteBalanceActionId.SelectWhiteBalance,
							options: {
								[WhiteBalanceModeId]: 'outdoor',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [{ feedbackId: FeedbackId.WhiteBalanceMode, options: { mode: 'outdoor' } }],
		},

		one_push_white_balance_preset: {
			type: 'button',
			category: 'White balance',
			name: 'One Push White Balance',
			style: {
				text: 'WB\\nONE PUSH',
				size: '14',
				color: White,
				bgcolor: Black,
			},
			steps: [
				{
					down: [
						{
							actionId: WhiteBalanceActionId.SelectWhiteBalance,
							options: {
								[WhiteBalanceModeId]: 'onepush',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [{ feedbackId: FeedbackId.WhiteBalanceMode, options: { mode: 'one-push' } }],
		},

		trigger_one_push_white_balance_preset: {
			type: 'button',
			category: 'White balance',
			name: 'Trigger One Push White Balance',
			style: {
				text: 'WB\\nTRIGGER\\nONE PUSH',
				size: '14',
				color: White,
				bgcolor: Black,
			},
			steps: [
				{
					down: [
						{
							actionId: WhiteBalanceActionId.WhiteBalanceOnePushTrigger,
							options: {},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		},
	}
}
