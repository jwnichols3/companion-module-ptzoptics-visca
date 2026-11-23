import {
	type CompanionVariableValue,
	type CompanionVariableValues,
	InstanceBase,
	InstanceStatus,
	type SomeCompanionConfigField,
} from '@companion-module/base'
import { getActions } from './actions/actions.js'
import {
	canUpdateConfigWithoutRestarting,
	type RawConfig,
	getConfigFields,
	httpPassword,
	isValidHost,
	noCameraConfig,
	type PtzOpticsConfig,
	type RawSecrets,
	validateConfig,
} from './config.js'
import { getFeedbacks, type StatusSource } from './feedbacks/feedbacks.js'
import { HttpStatusPoller, HttpVariables } from './http/http-status.js'
import { getPresets } from './presets/presets.js'
import { pollVariableDefinitions, StatusPoller } from './status/poller.js'
import { PresetTracker } from './status/preset-tracker.js'
import { ZoomTarget } from './status/zoom-target.js'
import { ZoomDirect } from './camera/zoom.js'
import { imageSetting } from './camera/image.js'
import { WhiteBalance } from './camera/white-balance.js'
import { ValueTargets } from './status/value-target.js'
import { repr } from './utils/repr.js'
import type { Command, CommandParameters, CommandParamValues, NoCommandParameters } from './visca/command.js'
import type { Answer, AnswerParameters, Inquiry } from './visca/inquiry.js'
import { VISCAPort } from './visca/port.js'

export class PtzOpticsInstance extends InstanceBase<RawConfig, RawSecrets> implements StatusSource {
	/** Configuration dictating the behavior of this instance. */
	#config: PtzOpticsConfig = noCameraConfig()

	/** Whether debug logging is enabled on this instance or not. */
	get debugLogging(): boolean {
		return this.#config.debugLogging
	}

	/** A port to use to communicate with the represented camera. */
	#visca = new VISCAPort(this)

	/** Polls the camera for status, if enabled in config. */
	#poller = new StatusPoller({
		canPoll: () => !this.#visca.closed,
		inquire: async (inquiry) => this.#visca.sendInquiry(inquiry).catch((e: Error) => e),
		setVariableValues: (values) => this.#publishStatus(values),
		passCompleted: (answered) => {
			// Feed the preset tracker every pass, not only when values change:
			// it needs repeated identical readings to know the camera arrived.
			if (answered) this.#trackPosition()
			if (answered === this.#statusFresh) return
			this.#statusFresh = answered
			this.checkFeedbacks()
		},
		log: (level, message) => this.log(level, message),
	})

	/** Reads status from the camera's web interface, if enabled in config. */
	#httpPoller = new HttpStatusPoller({
		setVariableValues: (values) => this.#publishStatus(values),
		log: (level, message) => this.log(level, message),
	})

	/** The latest value of every status variable this module publishes. */
	#status = new Map<string, CompanionVariableValue | undefined>()
	#statusFresh = true
	#presetTracker = new PresetTracker()

	statusValue(id: string): CompanionVariableValue | undefined {
		return this.#status.get(id)
	}

	get statusFresh(): boolean {
		return this.#statusFresh
	}

	/** Publish status values as variables, track the active preset, and update feedbacks. */
	#publishStatus(values: CompanionVariableValues): void {
		for (const [k, v] of Object.entries(values)) this.#status.set(k, v)

		this.setVariableValues(values)
		this.checkFeedbacks()
	}

	/** Give the preset tracker the current position; clear the active preset if the camera moved away. */
	#trackPosition(): void {
		const pan = this.#status.get('pan')
		const tilt = this.#status.get('tilt')
		const zoom = this.#status.get('zoom') ?? 0
		if (typeof pan !== 'number' || typeof tilt !== 'number' || typeof zoom !== 'number') return
		if (this.#presetTracker.position({ pan, tilt, zoom }, Date.now())) {
			this.#publishStatus({ last_preset: '' })
		}
	}

	#zoomTarget = new ZoomTarget()

	/** Zoom by a signed percentage of the zoom range from the current position. */
	zoomStep(percent: number): void {
		const zoom = this.#status.get('zoom')
		const position = this.#zoomTarget.step(
			percent,
			typeof zoom === 'number' ? zoom : undefined,
			this.#config.zoomMax,
			Date.now(),
		)
		if (position === null) {
			this.log('warn', 'Zoom step needs status polling with "Zoom and focus" on')
			return
		}
		this.sendCommand(ZoomDirect, { position })
	}

	/** Zoom to an absolute percentage of the zoom range. */
	zoomToPercent(percent: number): void {
		this.sendCommand(ZoomDirect, { position: this.#zoomTarget.toPercent(percent, this.#config.zoomMax, Date.now()) })
	}

	#imageTargets = new ValueTargets()

	/**
	 * Change a color or picture setting: step it from its current value, set
	 * it, or reset it.  Publishes the new value right away so knob displays
	 * keep up; the next poll confirms it.
	 */
	imageAdjust(
		id: string,
		change: { delta: number } | { value: number } | { reset: true },
		setWhiteBalance: boolean,
	): void {
		const setting = imageSetting(id)
		if (setting === undefined) {
			this.log('warn', `Unknown image setting: ${id}`)
			return
		}
		const { min, max, variable } = setting
		const now = Date.now()
		let value: number | null
		if ('delta' in change) {
			const polled = this.#status.get(variable)
			value = this.#imageTargets.step(id, change.delta, typeof polled === 'number' ? polled : undefined, min, max, now)
			if (value === null) {
				this.log('warn', `${setting.label} step needs status polling with its group on`)
				return
			}
		} else {
			value = this.#imageTargets.set(id, 'value' in change ? change.value : setting.center, min, max, now)
		}

		const needs = setting.needsWhiteBalance
		if (setWhiteBalance && needs !== undefined && this.#status.get('wb_mode') !== needs) {
			this.sendCommand(WhiteBalance, { mode: needs === 'color-temp' ? 'colortemp' : 'manual' })
			this.#publishStatus({ wb_mode: needs })
		}
		this.sendCommand(setting.command, { value })
		this.#publishStatus({ [variable]: value, [`${variable}_label`]: setting.display(value) })
	}

	/** Note that a preset was recalled, for the "last recalled preset" feedback. */
	notePresetRecalled(preset: number): void {
		this.#presetTracker.recalled(preset, Date.now())
		this.#publishStatus({ last_preset: preset })
	}

	/**
	 * Send the given command to the camera, filling in any parameters from the
	 * specified options.  The options must be compatible with the command's
	 * parameters.
	 *
	 * @param command
	 *    The command to send.
	 * @param paramValues
	 *    A parameter values object compatible with this command's parameters
	 *    and their types.  (This can be omitted if the command lacks
	 *    parameters.)
	 */
	sendCommand<CmdParameters extends CommandParameters>(
		command: Command<CmdParameters>,
		...paramValues: CmdParameters extends NoCommandParameters
			? [CommandParamValues<CmdParameters>?]
			: [CommandParamValues<CmdParameters>]
	): void {
		// `sendCommand` implicitly waits for the connection to be fully
		// established, so it's unnecessary to resolve `this.#visca.connect()`
		// here.
		this.#poller.noteActivity()
		this.#visca.sendCommand(command, ...paramValues).then(
			(result: void | Error) => {
				if (typeof result === 'undefined') {
					return
				}

				this.log('error', `Error processing command: ${result.message}`)
			},
			(reason: Error) => {
				// Swallow the error so that execution gracefully unwinds.
				this.log('error', `Unhandled command rejection was suppressed: ${reason}`)
				return
			},
		)
	}

	/**
	 * Send the given inquiry to the camera.
	 *
	 * @param inquiry
	 *    The inquiry to send.
	 * @returns
	 *    A promise that resolves after the response to `inquiry` (which may be
	 *    an error response) has been processed.  If `inquiry`'s response was an
	 *    an error not implicating overall connection stability, the promise
	 *    resolves null.  Otherwise it resolves an object whose properties are
	 *    choices corresponding to the parameters in the response.
	 */
	async sendInquiry<Parameters extends AnswerParameters>(
		inquiry: Inquiry<Parameters>,
	): Promise<Answer<Parameters> | null> {
		// `sendInquiry` implicitly waits for the connection to be fully
		// established, so it's unnecessary to resolve `this.#visca.connect()`
		// here.
		return this.#visca.sendInquiry(inquiry).then(
			(result: Answer<Parameters> | Error) => {
				if (result instanceof Error) {
					this.log('error', `Error processing inquiry: ${result.message}`)
					return null
				}

				return result
			},
			(reason: Error) => {
				// Swallow the error so that execution gracefully unwinds.
				this.log('error', `Unhandled inquiry rejection was suppressed: ${reason}`)
				return null
			},
		)
	}

	/**
	 * The speed to be passed in the pan/tilt speed parameters of Pan Tilt Drive
	 * VISCA commands.  Ranges between 0x01 (low speed) and 0x18 (high speed).
	 * However, as 0x15-0x18 are valid only for panning, tilt speed is capped at
	 * 0x14.
	 */
	#speed = 0x0c

	panTiltSpeed(): { panSpeed: number; tiltSpeed: number } {
		return {
			panSpeed: this.#speed,
			tiltSpeed: Math.min(this.#speed, 0x14),
		}
	}

	setPanTiltSpeed(speed: number): void {
		if (0x01 <= speed && speed <= 0x18) {
			this.#speed = speed
		} else {
			this.log('debug', `speed ${speed} unexpectedly not in range [0x01, 0x18]`)
			this.#speed = 0x0c
		}
		this.#publishSpeed()
	}

	increasePanTiltSpeed(): void {
		if (this.#speed < 0x18) this.#speed++
		this.#publishSpeed()
	}

	decreasePanTiltSpeed(): void {
		if (this.#speed > 0x01) this.#speed--
		this.#publishSpeed()
	}

	#publishSpeed(): void {
		this.#publishStatus({ pt_speed: this.#speed })
	}

	override getConfigFields(): SomeCompanionConfigField[] {
		return getConfigFields()
	}

	override async destroy(): Promise<void> {
		this.log('info', `destroying module: ${this.id}`)
		this.#poller.stop()
		this.#httpPoller.stop()
		this.#visca.close('Instance is being destroyed', InstanceStatus.Disconnected)
	}

	override async init(config: RawConfig, _isFirstInit: boolean, secrets: RawSecrets): Promise<void> {
		this.#logConfig(config, 'init()')

		this.setActionDefinitions(getActions(this))
		this.setFeedbackDefinitions(getFeedbacks(this))
		this.setPresetDefinitions(getPresets())

		return this.configUpdated(config, secrets)
	}

	override async configUpdated(config: RawConfig, secrets: RawSecrets): Promise<void> {
		this.#logConfig(config, 'configUpdated()')

		const oldConfig = this.#config

		validateConfig(config)
		this.#config = config

		this.#status.clear()
		this.#statusFresh = true
		this.setVariableDefinitions([
			{ variableId: 'pt_speed', name: 'Pan/tilt speed used by movement actions (1-24)' },
			{
				variableId: 'last_preset',
				name: 'Preset last recalled by this module, until the camera moves away (blank if none)',
			},
			...(config.pollEnabled ? pollVariableDefinitions(config.pollGroups) : []),
			...(config.httpEnabled ? HttpVariables : []),
		])
		this.#publishSpeed()
		this.#poller.configure({
			enabled: config.pollEnabled,
			interval: config.pollInterval,
			groups: config.pollGroups,
			zoomMax: config.zoomMax,
		})
		this.#httpPoller.configure({
			enabled: config.httpEnabled && isValidHost(config.host),
			host: config.host,
			port: config.httpPort,
			username: config.httpUser,
			password: httpPassword(secrets),
			interval: config.httpInterval,
		})

		if (canUpdateConfigWithoutRestarting(oldConfig, config)) {
			return
		}

		if (!isValidHost(this.#config.host)) {
			this.#visca.close('no host specified', InstanceStatus.Disconnected)
		} else {
			// Initiate the connection (closing any prior connection), but don't
			// delay to fully establish it as `await this.#visca.connect()`
			// would, because network vagaries might make this take a long time.
			this.#visca.open(this.#config.host, this.#config.port)
		}
	}

	/**
	 * Write a copy of the given module config information to logs.
	 *
	 * @param config
	 *   The config information to log.
	 * @param desc
	 *   A description of the event occasioning the logging.
	 */
	#logConfig(config: RawConfig, desc = 'logConfig()'): void {
		this.log('info', `PTZOptics module configuration on ${desc}: ${repr(config)}`)
	}
}
