import { describe, expect, test } from 'vitest'
import { ZoomTarget } from './zoom-target.js'

const Max = 0x4000

describe('zoom target', () => {
	test('steps from the polled position', () => {
		expect(new ZoomTarget().step(10, 8192, Max, 0)).toBe(8192 + 1638)
	})

	test('fast turns accumulate before the next poll', () => {
		const z = new ZoomTarget()
		z.step(10, 8192, Max, 0)
		expect(z.step(10, 8192, Max, 200)).toBe(11468) // 9830, then + 1638.4
	})

	test('after an idle second, steps restart from the polled position', () => {
		const z = new ZoomTarget()
		z.step(10, 8192, Max, 0)
		expect(z.step(-10, 4000, Max, 1500)).toBe(Math.round(4000 - 1638.4))
	})

	test('clamps to the zoom range', () => {
		expect(new ZoomTarget().step(50, 15000, Max, 0)).toBe(Max)
		expect(new ZoomTarget().step(-50, 100, Max, 0)).toBe(0)
		expect(new ZoomTarget().toPercent(150, Max, 0)).toBe(Max)
	})

	test('unknown start position', () => {
		expect(new ZoomTarget().step(5, undefined, Max, 0)).toBeNull()
	})
})
