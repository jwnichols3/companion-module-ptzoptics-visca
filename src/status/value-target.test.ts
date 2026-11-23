import { describe, expect, test } from 'vitest'
import { ValueTargets } from './value-target.js'

describe('ValueTargets', () => {
	test('first step starts from the polled value', () => {
		const t = new ValueTargets()
		expect(t.step('sat', 1, 4, 0, 14, 0)).toBe(5)
	})
	test('quick steps add up, ignoring a stale poll', () => {
		const t = new ValueTargets()
		t.step('sat', 1, 4, 0, 14, 0)
		expect(t.step('sat', 1, 4, 0, 14, 500)).toBe(6)
	})
	test('after a pause, the polled value wins', () => {
		const t = new ValueTargets()
		t.step('sat', 1, 4, 0, 14, 0)
		expect(t.step('sat', 1, 9, 0, 14, 2000)).toBe(10)
	})
	test('keys are independent and values clamp', () => {
		const t = new ValueTargets()
		t.step('sat', 1, 4, 0, 14, 0)
		expect(t.step('hue', -5, 2, 0, 14, 100)).toBe(0)
		expect(t.step('sat', 50, 4, 0, 14, 200)).toBe(14)
	})
	test('unknown start returns null', () => {
		expect(new ValueTargets().step('sat', 1, undefined, 0, 14, 0)).toBeNull()
	})
})
