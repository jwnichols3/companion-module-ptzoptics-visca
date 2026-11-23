import { ModuleDefinedCommand } from '../visca/command.js'

/**
 * Picture settings that have an absolute "direct" command and a matching
 * inquiry, so they can be stepped from a knob and shown as a live value.
 *
 * Commands and ranges are from PTZOptics' VISCA and HTTP API documentation,
 * and were checked by reading back after each set on a PTZOptics Move SE
 * (F64.HI, firmware SOC v9.1.34) in November 2026.
 */
export const ImageSettingId = {
	ColorTemperature: 'colorTemp',
	RedTuning: 'redTuning',
	BlueTuning: 'blueTuning',
	RedGain: 'redGain',
	BlueGain: 'blueGain',
	Saturation: 'saturation',
	Hue: 'hue',
	Contrast: 'contrast',
	Luminance: 'luminance',
	Sharpness: 'sharpness',
	ExposureCompensation: 'expComp',
} as const

export type ImageSettingId = (typeof ImageSettingId)[keyof typeof ImageSettingId]

/** White balance modes a setting needs before the camera will apply it. */
type RequiredWhiteBalance = 'color-temp' | 'manual'

type ValueCommand = ModuleDefinedCommand<{ value: { nibbles: [number, ...number[]] } }>

type ImageSetting = {
	readonly id: ImageSettingId
	/** Name shown in action and feedback dropdowns. */
	readonly label: string
	/** Variable holding the raw value; `<variable>_label` holds the display form. */
	readonly variable: string
	readonly min: number
	readonly max: number
	/** Default used by "reset": neutral for tuning, hue, contrast, brightness, exp comp; this rig's start values for the rest. */
	readonly center: number
	readonly command: ValueCommand
	/** Inquiry `81 09 iq[0] iq[1] FF`; the answer is `90 50 pq FF` if `byteAnswer`, else `90 50 00 00 0p 0q FF`. */
	readonly inquiry: readonly [number, number]
	readonly byteAnswer?: boolean
	/** If set, the camera ignores this setting unless white balance is in this mode. */
	readonly needsWhiteBalance?: RequiredWhiteBalance
	/** Human-readable form of a raw value. */
	readonly display: (raw: number) => string
}

/** `81 01 04 cc 00 00 0p 0q FF`: an 8-bit value in the low nibbles of bytes 6 and 7. */
function pq(cc: number): ValueCommand {
	return new ModuleDefinedCommand([0x81, 0x01, 0x04, cc, 0x00, 0x00, 0x00, 0x00, 0xff], {
		value: { nibbles: [13, 15] },
	})
}

const signed = (raw: number, center: number) => {
	const v = raw - center
	return v > 0 ? `+${v}` : String(v)
}

export const ImageSettings: readonly ImageSetting[] = [
	{
		id: ImageSettingId.ColorTemperature,
		inquiry: [0x04, 0x20],
		byteAnswer: true,
		label: 'Color temperature',
		variable: 'color_temp',
		min: 0,
		max: 55,
		center: 40,
		// 81 01 04 20 0p 0q FF; 0 = 2500K .. 55 = 8000K, 100K per step.
		command: new ModuleDefinedCommand([0x81, 0x01, 0x04, 0x20, 0x00, 0x00, 0xff], { value: { nibbles: [9, 11] } }),
		needsWhiteBalance: 'color-temp',
		display: (raw) => `${2500 + raw * 100}K`,
	},
	{
		id: ImageSettingId.RedTuning,
		inquiry: [0x04, 0x12],
		label: 'Red tuning (-10 to +10)',
		variable: 'r_tuning',
		min: 0,
		max: 20,
		center: 10,
		// 81 0A 01 12 pq FF; works on top of auto, one push and color temperature.
		command: new ModuleDefinedCommand([0x81, 0x0a, 0x01, 0x12, 0x00, 0xff], { value: { nibbles: [8, 9] } }),
		display: (raw) => signed(raw, 10),
	},
	{
		id: ImageSettingId.BlueTuning,
		inquiry: [0x04, 0x13],
		label: 'Blue tuning (-10 to +10)',
		variable: 'b_tuning',
		min: 0,
		max: 20,
		center: 10,
		command: new ModuleDefinedCommand([0x81, 0x0a, 0x01, 0x13, 0x00, 0xff], { value: { nibbles: [8, 9] } }),
		display: (raw) => signed(raw, 10),
	},
	{
		id: ImageSettingId.RedGain,
		inquiry: [0x04, 0x43],
		label: 'Red gain (manual white balance)',
		variable: 'wb_red',
		min: 0,
		max: 255,
		center: 128,
		command: pq(0x43),
		needsWhiteBalance: 'manual',
		display: (raw) => String(raw),
	},
	{
		id: ImageSettingId.BlueGain,
		inquiry: [0x04, 0x44],
		label: 'Blue gain (manual white balance)',
		variable: 'wb_blue',
		min: 0,
		max: 255,
		center: 128,
		command: pq(0x44),
		needsWhiteBalance: 'manual',
		display: (raw) => String(raw),
	},
	{
		id: ImageSettingId.Saturation,
		inquiry: [0x04, 0x49],
		label: 'Saturation (60% to 200%)',
		variable: 'saturation',
		min: 0,
		max: 14,
		center: 4,
		command: pq(0x49),
		display: (raw) => `${60 + raw * 10}%`,
	},
	{
		id: ImageSettingId.Hue,
		inquiry: [0x04, 0x4f],
		label: 'Hue (-14° to +14°)',
		variable: 'hue',
		min: 0,
		max: 14,
		center: 7,
		command: pq(0x4f),
		display: (raw) => `${signed((raw - 7) * 2, 0)}°`,
	},
	{
		id: ImageSettingId.Contrast,
		inquiry: [0x04, 0xa2],
		label: 'Contrast',
		variable: 'contrast',
		min: 0,
		max: 14,
		center: 7,
		command: pq(0xa2),
		display: (raw) => signed(raw, 7),
	},
	{
		id: ImageSettingId.Luminance,
		inquiry: [0x04, 0xa1],
		label: 'Brightness (luminance)',
		variable: 'luminance',
		min: 0,
		max: 14,
		center: 7,
		command: pq(0xa1),
		display: (raw) => signed(raw, 7),
	},
	{
		id: ImageSettingId.Sharpness,
		inquiry: [0x04, 0x42],
		label: 'Sharpness',
		variable: 'sharpness',
		min: 0,
		max: 15,
		center: 4,
		command: pq(0x42),
		display: (raw) => String(raw),
	},
	{
		id: ImageSettingId.ExposureCompensation,
		inquiry: [0x04, 0x4e],
		label: 'Exposure compensation',
		variable: 'exp_comp',
		min: 0,
		max: 14,
		center: 7,
		command: pq(0x4e),
		display: (raw) => signed(raw, 7),
	},
]

export function imageSetting(id: unknown): ImageSetting | undefined {
	return ImageSettings.find((s) => s.id === id)
}

/** Save the current image settings so they survive a power cycle. */
export const SaveImageSettings = new ModuleDefinedCommand([0x81, 0x01, 0x04, 0xa5, 0x10, 0xff])

/** Pan/tilt relative move: `81 01 06 03 VV WW 0Y 0Y 0Y 0Y 0Z 0Z 0Z 0Z FF`, signed 16-bit steps. */
export const PanTiltRelative = new ModuleDefinedCommand(
	[0x81, 0x01, 0x06, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff],
	{
		panSpeed: { nibbles: [8, 9] },
		tiltSpeed: { nibbles: [10, 11] },
		pan: { nibbles: [13, 15, 17, 19], convert: (v: number) => v & 0xffff },
		tilt: { nibbles: [21, 23, 25, 27], convert: (v: number) => v & 0xffff },
	},
)
