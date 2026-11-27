import { describe, expect, test } from 'vitest'
import { GenericVisca } from './cameras/index.js'
import {
	type RawConfig,
	CameraModelOptionId,
	DebugLoggingOptionId,
	getConfigFields,
	tryUpdateConfigWithCameraModel,
	tryUpdateConfigWithDebugLogging,
	validateConfig,
} from './config.js'

describe('config upgrade to specify debug logging', () => {
	test('config without debug logging', () => {
		const configMissingDebugLogging: RawConfig = {
			host: '127.0.0.1',
			port: '5678',
		}
		expect(DebugLoggingOptionId in configMissingDebugLogging).toBe(false)

		expect(tryUpdateConfigWithDebugLogging(configMissingDebugLogging)).toBe(true)
		expect(DebugLoggingOptionId in configMissingDebugLogging).toBe(true)
		expect(configMissingDebugLogging[DebugLoggingOptionId]).toBe(false)

		expect(tryUpdateConfigWithDebugLogging(configMissingDebugLogging)).toBe(false)
	})

	test('config with debug logging=false', () => {
		const configWithDebugLoggingFalse: RawConfig = {
			host: '127.0.0.1',
			port: '5678',
			debugLogging: false,
		}

		expect(tryUpdateConfigWithDebugLogging(configWithDebugLoggingFalse)).toBe(false)
		expect(configWithDebugLoggingFalse[DebugLoggingOptionId]).toBe(false)
	})

	test('config with debug logging=true', () => {
		const configWithDebugLoggingTrue: RawConfig = {
			host: '127.0.0.1',
			port: '5678',
			debugLogging: true,
		}

		expect(tryUpdateConfigWithDebugLogging(configWithDebugLoggingTrue)).toBe(false)
		expect(configWithDebugLoggingTrue[DebugLoggingOptionId]).toBe(true)
	})
})

describe('config upgrade to specify the camera model', () => {
	test('config without a camera model', () => {
		const configMissingCameraModel: RawConfig = {
			host: '127.0.0.1',
			port: '5678',
			pollEnabled: true,
			zoomMax: 12345,
		}
		expect(CameraModelOptionId in configMissingCameraModel).toBe(false)

		expect(tryUpdateConfigWithCameraModel(configMissingCameraModel)).toBe(true)
		expect(configMissingCameraModel).toEqual({
			host: '127.0.0.1',
			port: '5678',
			pollEnabled: true,
			zoomMax: 12345,
			cameraModel: 'generic-visca',
		})

		expect(tryUpdateConfigWithCameraModel(configMissingCameraModel)).toBe(false)
	})

	test('config with a camera model', () => {
		const configWithCameraModel: RawConfig = {
			host: '127.0.0.1',
			port: '5678',
			cameraModel: 'some-camera',
		}

		expect(tryUpdateConfigWithCameraModel(configWithCameraModel)).toBe(false)
		expect(configWithCameraModel[CameraModelOptionId]).toBe('some-camera')
	})
})

describe('camera model config option', () => {
	test('is a dropdown of the built-in camera definitions, Generic VISCA by default', () => {
		const field = getConfigFields().find(({ id }) => id === CameraModelOptionId)

		expect(field).toMatchObject({ type: 'dropdown', label: 'Camera model', default: 'generic-visca' })
		expect(field).toHaveProperty('choices[0]', { id: 'generic-visca', label: 'Generic VISCA' })
	})

	test('the PTZOptics 20X (F64.HI) can be chosen, and stays chosen', () => {
		const field = getConfigFields().find(({ id }) => id === CameraModelOptionId)
		expect(field).toHaveProperty(
			'choices',
			expect.arrayContaining([{ id: 'ptzoptics-20x-f64hi', label: 'PTZOptics 20X (F64.HI)' }]),
		)

		const config: RawConfig = { host: '127.0.0.1', port: '5678', cameraModel: 'ptzoptics-20x-f64hi' }
		validateConfig(config)
		expect(config.cameraModel).toBe('ptzoptics-20x-f64hi')
	})

	test('a missing or unknown camera model is Generic VISCA', () => {
		const configMissingCameraModel: RawConfig = { host: '127.0.0.1', port: '5678' }
		validateConfig(configMissingCameraModel)
		expect(configMissingCameraModel.cameraModel).toBe('generic-visca')

		const configWithUnknownCameraModel: RawConfig = { host: '127.0.0.1', port: '5678', cameraModel: 'no-such-camera' }
		validateConfig(configWithUnknownCameraModel)
		expect(configWithUnknownCameraModel.cameraModel).toBe('generic-visca')
	})
})

describe('full-telephoto zoom position config option', () => {
	test("is the camera model's unless a position is entered", () => {
		const field = getConfigFields().find(({ id }) => id === 'zoomMax')
		expect(field).toMatchObject({ type: 'number', default: 0, min: 0 })

		const configMissingZoomMax: RawConfig = { host: '127.0.0.1', port: '5678' }
		validateConfig(configMissingZoomMax)
		expect(configMissingZoomMax.zoomMax).toBe(0x4000)
		expect(GenericVisca.ranges.zoomMax).toBe(0x4000)

		const configWithZoomMaxZero: RawConfig = { host: '127.0.0.1', port: '5678', zoomMax: 0 }
		validateConfig(configWithZoomMaxZero)
		expect(configWithZoomMaxZero.zoomMax).toBe(0x4000)

		const configWithZoomMax: RawConfig = { host: '127.0.0.1', port: '5678', zoomMax: 12345 }
		validateConfig(configWithZoomMax)
		expect(configWithZoomMax.zoomMax).toBe(12345)
	})
})
