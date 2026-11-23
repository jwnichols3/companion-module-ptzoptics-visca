import { describe, expect, test } from 'vitest'
import { PresetTracker } from './preset-tracker.js'

const at = (pan: number, tilt = 0, zoom = 0) => ({ pan, tilt, zoom })

describe('preset tracker', () => {
	test('keeps the preset while the camera travels and sits there', () => {
		const t = new PresetTracker()
		t.recalled(3, 0)
		expect(t.position(at(100), 200)).toBe(false) // travelling
		expect(t.position(at(500), 400)).toBe(false)
		expect(t.position(at(800), 1200)).toBe(false)
		expect(t.position(at(800), 1400)).toBe(false) // settled
		expect(t.position(at(801), 2400)).toBe(false) // jitter within tolerance
		expect(t.current).toBe(3)
	})

	test('clears when the camera is moved away after arriving', () => {
		const t = new PresetTracker()
		t.recalled(3, 0)
		t.position(at(800), 1200)
		t.position(at(800), 1400)
		expect(t.position(at(900), 3000)).toBe(true)
		expect(t.current).toBeNull()
	})

	test('does not settle before the minimum settle time', () => {
		const t = new PresetTracker()
		t.recalled(5, 0)
		t.position(at(0), 100) // camera hasn't started moving yet
		t.position(at(0), 300)
		expect(t.position(at(700), 900)).toBe(false) // still travelling: not a move away
		expect(t.current).toBe(5)
	})

	test('a new recall replaces the old preset', () => {
		const t = new PresetTracker()
		t.recalled(1, 0)
		t.recalled(2, 10)
		expect(t.current).toBe(2)
	})

	test('zoom change also clears', () => {
		const t = new PresetTracker()
		t.recalled(4, 0)
		t.position(at(0, 0, 1000), 1100)
		t.position(at(0, 0, 1000), 1300)
		expect(t.position(at(0, 0, 3000), 2000)).toBe(true)
	})
})
