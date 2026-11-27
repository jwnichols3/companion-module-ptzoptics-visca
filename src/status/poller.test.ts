import type { CompanionVariableValues } from '@companion-module/base'
import { describe, expect, test } from 'vitest'
import { GenericVisca } from '../cameras/index.js'
import { PollGroupId, PollGroups } from './groups.js'
import { pollVariableDefinitions, type PollTarget, StatusPoller } from './poller.js'
import type { Answer, AnswerParameters, Inquiry } from '../visca/inquiry.js'
import { prettyBytes } from '../utils/pretty.js'

/**
 * Answers observed from a PTZOptics camera (2026-11-22), keyed by inquiry
 * bytes, already split into the parameters each polled inquiry declares.
 */
const RealAnswers: Record<string, Answer<AnswerParameters>> = {
	'[81 09 04 00 FF]': { p: 0x2 }, // 90 50 02 FF: power on
	'[81 09 06 12 FF]': { pan: 0xfddf, tilt: 0xffbc }, // 90 50 0F 0D 0D 0F 0F 0F 0B 0C FF
	'[81 09 04 47 FF]': { p: 0x28f7 }, // 90 50 02 08 0F 07 FF
	'[81 09 04 48 FF]': { p: 0x0772 }, // 90 50 00 07 07 02 FF
	'[81 09 04 38 FF]': { p: 0x2 }, // 90 50 02 FF: autofocus
	'[81 09 04 39 FF]': { p: 0x0 }, // full auto
	'[81 09 04 4B FF]': { p: 0x11 },
	'[81 09 04 4A FF]': { p: 0x05 },
	'[81 09 04 4C FF]': { p: 0x02 },
	'[81 09 04 4D FF]': { p: 0x07 },
	'[81 09 04 35 FF]': { p: 0x0 },
	'[81 09 04 43 FF]': { p: 0x78 },
	'[81 09 04 44 FF]': { p: 0x80 },
	'[81 09 04 66 FF]': { p: 0x3 },
	'[81 09 04 61 FF]': { p: 0x3 },
	// Color and picture, read 2026-11-22
	'[81 09 04 20 FF]': { p: 0x28 }, // 90 50 28 FF: 6500K
	'[81 09 04 12 FF]': { p: 0x0d },
	'[81 09 04 13 FF]': { p: 0x0b },
	'[81 09 04 49 FF]': { p: 0x04 },
	'[81 09 04 4F FF]': { p: 0x07 },
	'[81 09 04 A2 FF]': { p: 0x07 },
	'[81 09 04 A1 FF]': { p: 0x07 },
	'[81 09 04 42 FF]': { p: 0x04 },
	'[81 09 04 4E FF]': { p: 0x06 },
}

class FakeTarget implements PollTarget {
	values: CompanionVariableValues[] = []
	logs: string[] = []
	sent: string[] = []
	answers: Record<string, Answer<AnswerParameters> | Error>

	constructor(answers: Record<string, Answer<AnswerParameters> | Error> = { ...RealAnswers }) {
		this.answers = answers
	}

	canPoll(): boolean {
		return true
	}

	async inquire(inquiry: Inquiry<AnswerParameters>): Promise<Answer<AnswerParameters> | Error> {
		const key = prettyBytes(inquiry.toBytes())
		this.sent.push(key)
		return this.answers[key] ?? new Error(`syntax error for ${key}`)
	}

	setVariableValues(values: CompanionVariableValues): void {
		this.values.push(values)
	}

	passes: boolean[] = []
	passCompleted(answered: boolean): void {
		this.passes.push(answered)
	}

	log(_level: string, message: string): void {
		this.logs.push(message)
	}
}

const allGroups = PollGroups.map((g) => g.id)

function poller(target: FakeTarget, groups = allGroups): StatusPoller {
	const p = new StatusPoller(target)
	// Configure disabled so no timer runs; pollOnce is driven by the test.
	p.configure({ enabled: false, interval: 1000, groups, camera: GenericVisca, zoomMax: 0x4000 })
	return p
}

describe('status poller', () => {
	test('decodes real camera answers into variables', async () => {
		const target = new FakeTarget()
		await poller(target).pollOnce()

		expect(target.values).toEqual([
			{
				power: 'on',
				pan: -545,
				tilt: -68,
				zoom: 10487,
				zoom_pct: 64,
				focus: 1906,
				focus_mode: 'auto',
				exposure_mode: 'full-auto',
				iris: 0x11,
				shutter: 5,
				gain: 2,
				brightness: 7,
				wb_mode: 'auto',
				wb_red: 0x78,
				wb_blue: 0x80,
				flip: 'off',
				mirror: 'off',
				color_temp: 40,
				color_temp_label: '6500K',
				r_tuning: 13,
				r_tuning_label: '+3',
				b_tuning: 11,
				b_tuning_label: '+1',
				saturation: 4,
				saturation_label: '100%',
				hue: 7,
				hue_label: '0°',
				contrast: 7,
				contrast_label: '0',
				luminance: 7,
				luminance_label: '0',
				sharpness: 4,
				sharpness_label: '4',
				exp_comp: 6,
				exp_comp_label: '-1',
			},
		])
	})

	test('reads color temperature white balance mode', async () => {
		const target = new FakeTarget({ ...RealAnswers, '[81 09 04 35 FF]': { p: 0x20 } })
		await poller(target, [PollGroupId.WhiteBalance]).pollOnce()
		expect(target.values[0]?.['wb_mode']).toBe('color-temp')
	})

	test('publishes only changed values', async () => {
		const target = new FakeTarget()
		const p = poller(target, [PollGroupId.Lens])
		await p.pollOnce()
		await p.pollOnce()
		expect(target.values).toHaveLength(1)

		target.answers['[81 09 04 47 FF]'] = { p: 0x4000 }
		await p.pollOnce()
		expect(target.values[1]).toEqual({ zoom: 0x4000, zoom_pct: 100 })
	})

	test('sends only the selected groups', async () => {
		const target = new FakeTarget()
		await poller(target, [PollGroupId.Power]).pollOnce()
		expect(target.sent).toEqual(['[81 09 04 00 FF]'])
	})

	test('drops an inquiry the camera does not support, after three passes', async () => {
		const target = new FakeTarget()
		delete target.answers['[81 09 04 66 FF]']
		const p = poller(target, [PollGroupId.Image])
		await p.pollOnce()
		await p.pollOnce()
		expect(target.logs).toEqual([])
		await p.pollOnce()
		expect(target.logs).toHaveLength(1)
		expect(target.values).toEqual([{ mirror: 'off' }])

		target.sent = []
		await p.pollOnce()
		expect(target.sent).toEqual(['[81 09 04 61 FF]'])
	})

	test('keeps every inquiry when all of them fail (camera unreachable)', async () => {
		const target = new FakeTarget({})
		const p = poller(target, [PollGroupId.Lens])
		await p.pollOnce()
		await p.pollOnce()
		expect(target.logs).toEqual([])
		expect(target.sent).toHaveLength(6)
	})

	test('polls only power while the camera is in standby, then resumes', async () => {
		// Seen 2026-11-25: in standby, power answers 90 50 03 FF and pan-tilt,
		// zoom and the rest answer Command Not Executable.
		const target = new FakeTarget({ '[81 09 04 00 FF]': { p: 0x3 } })
		const p = poller(target, [PollGroupId.Power, PollGroupId.Lens])
		await p.pollOnce()
		await p.pollOnce()
		expect(target.sent).toEqual(['[81 09 04 00 FF]', '[81 09 04 00 FF]'])
		expect(target.values).toEqual([{ power: 'standby' }])
		expect(target.logs).toEqual([])

		target.answers = { ...RealAnswers }
		target.sent = []
		await p.pollOnce()
		expect(target.sent).toHaveLength(4)
		expect(target.values[1]).toMatchObject({ power: 'on', zoom: 10487 })
	})

	test('variable definitions follow the selected groups', () => {
		expect(pollVariableDefinitions([PollGroupId.Power]).map((v) => v.variableId)).toEqual(['power'])
		expect(pollVariableDefinitions([])).toEqual([])
	})
})
