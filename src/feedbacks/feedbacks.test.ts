import type { CompanionFeedbackBooleanEvent, CompanionVariableValue } from '@companion-module/base'
import { describe, expect, test } from 'vitest'
import { FeedbackId, getFeedbacks } from './feedbacks.js'

function run(values: Record<string, CompanionVariableValue>, id: string, options = {}, fresh = true): boolean {
	const defs = getFeedbacks({ statusValue: (k) => values[k], statusFresh: fresh })
	const def = defs[id]
	if (def?.type !== 'boolean') throw new Error(`no boolean feedback ${id}`)
	return def.callback({ options } as CompanionFeedbackBooleanEvent, {} as never) as boolean
}

describe('feedbacks', () => {
	test('modes', () => {
		expect(run({ focus_mode: 'manual' }, FeedbackId.FocusMode, { mode: 'manual' })).toBe(true)
		expect(run({ wb_mode: 'auto' }, FeedbackId.WhiteBalanceMode, { mode: 'indoor' })).toBe(false)
		expect(run({ power: 'on' }, FeedbackId.Power)).toBe(true)
	})

	test('comparisons', () => {
		expect(run({ zoom_pct: 85 }, FeedbackId.Zoom, { op: 'gt', percent: 80 })).toBe(true)
		expect(run({ zoom_pct: 85 }, FeedbackId.Zoom, { op: 'lt', percent: 80 })).toBe(false)
		expect(run({ pt_speed: 12 }, FeedbackId.Speed, { op: 'eq', speed: 12 })).toBe(true)
		expect(run({}, FeedbackId.Zoom, { op: 'lt', percent: 80 })).toBe(false) // unknown is never true
	})

	test('moving, autotrack, preset, stale', () => {
		expect(run({ zoom_moving: 'true', moving: 'true' }, FeedbackId.Moving, { axis: 'pt_moving' })).toBe(false)
		expect(run({ moving: 'true' }, FeedbackId.Moving, { axis: 'moving' })).toBe(true)
		expect(run({ autotrack: 'on' }, FeedbackId.AutoTracking)).toBe(true)
		expect(run({ last_preset: 3 }, FeedbackId.LastPreset, { preset: 3 })).toBe(true)
		expect(run({ last_preset: '' }, FeedbackId.LastPreset, { preset: 0 })).toBe(false)
		expect(run({}, FeedbackId.Stale, {}, false)).toBe(true)
	})
})
