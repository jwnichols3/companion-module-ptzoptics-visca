import {
	type CompanionVariableValue,
	type CompanionVariableValues,
	InstanceBase,
	InstanceStatus,
	type LogLevel,
	type SomeCompanionConfigField,
} from '@companion-module/base'
import { getActions } from './actions/actions.js'
import {
	canUpdateConfigWithoutRestarting,
	type RawConfig,
	cameraDefinition,
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
import { CameraPower, CameraPowerState } from './camera/power.js'
import { ZoomDirect } from './camera/zoom.js'
import { imageSetting } from './camera/image.js'
import { WhiteBalance } from './camera/white-balance.js'
import { ValueTargets } from './status/value-target.js'
import { repr } from './utils/repr.js'
import type { Command, CommandParameters, CommandParamValues, NoCommandParameters } from './visca/command.js'
import type { Answer, AnswerParameters, Inquiry } from './visca/inquiry.js'
import { VISCAPort } from './visca/port.js'

/**
 * How long the camera gets to answer anything at all, once it's been sent an
 * inquiry by the status poller, before the connection is taken for lost.  A
 * camera that's powering on stops answering without closing the connection,
 * so nothing else reveals the loss.  Comfortably longer than the slowest
 * answer seen from a real camera, about a second.
 */
const InquiryTimeoutMs = 3000

/**
 * How long the camera gets to answer an inquiry sent by the status poller
 * before it's sent another, a probe, to find out whether it ignored the first.
 * Some cameras send nothing in reply to an inquiry they don't have.
 *
 * A camera answers in order, so nothing is lost by probing early: if the
 * first inquiry is only being answered slowly, its answer arrives ahead of the
 * probe's and is used all the same.  So this needs only be longer than most
 * answers take, to spare the camera a probe it doesn't need.  Answers seen
 * from real cameras took 10 to 20 ms, and now and then about 350 ms.
 */
const InquiryProbeAfterMs = 500

/**
 * The longest a command is held back for a polled inquiry to be answered, or
 * a polled inquiry for commands to be acknowledged, before it's sent anyway.
 * A camera usually answers within about 20 ms, so the wait is usually far
 * shorter.  Short enough that a button press never feels delayed even if the
 * camera has stopped answering.
 */
export const OverlapWaitLimitMs = 100

/**
 * Resolve what the promise resolves, or `'unanswered'` if it hasn't resolved
 * within the given number of milliseconds.
 */
async function unlessUnansweredWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'unanswered'> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const limit = new Promise<'unanswered'>((resolve) => {
		timer = setTimeout(() => {
			resolve('unanswered')
		}, ms)
	})
	return Promise.race([promise, limit]).finally(() => {
		clearTimeout(timer)
	})
}

/** Wait for the promise to resolve, but for no longer than the given number of milliseconds. */
async function resolvedWithin(promise: Promise<void>, ms: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const limit = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, ms)
	})
	return Promise.race([promise, limit]).finally(() => {
		clearTimeout(timer)
	})
}

export class PtzOpticsInstance extends InstanceBase<RawConfig, RawSecrets> implements StatusSource {
	/** Configuration dictating the behavior of this instance. */
	#config: PtzOpticsConfig = noCameraConfig()

	/** Whether debug logging is enabled on this instance or not. */
	get debugLogging(): boolean {
		return this.#config.debugLogging
	}

	/** A port to use to communicate with the represented camera. */
	#visca = new VISCAPort(this)

	/** Whether the port has a connection to the camera now. */
	#connected = false

	/** How many connections to the camera the port has made, to tell one from the next. */
	#connectionsMade = 0

	/** The connection status last reported to Companion, if any. */
	#statusShown: InstanceStatus | null = null

	/**
	 * Whether the camera was told to go to standby since it was last told to
	 * power on, so that it may be in standby whatever it last said.
	 */
	#toldToStandby = false

	/**
	 * The wake window, while it lasts: the time after the camera acknowledged
	 * being told to power on in which it's expected to answer nothing, and
	 * perhaps to refuse connections.  It lasts until the camera answers a
	 * polled inquiry, or for as long as its camera definition says a wake-up
	 * may take.  Null at any other time.
	 *
	 * In the wake window a camera that can't be reached, or doesn't answer, is
	 * taken to be waking, not lost: the connection is reported as being made,
	 * not as failed, and one line is logged in place of a warning or an error
	 * for each inquiry unanswered and each connection refused.
	 */
	#wakeWindow: {
		/** Whether the camera has been found unreachable or silent since the connection was last reported ok. */
		silent: boolean
		/** Whether it's been logged that the camera is waking. */
		said: boolean
		readonly lasts: number
		readonly timer: ReturnType<typeof setTimeout>
	} | null = null

	/**
	 * Note that the camera acknowledged being told to power on when it wasn't
	 * known to be on: the wake window starts.
	 */
	#wakeWindowStarts(): void {
		this.#wakeWindowEnds()
		const lasts = cameraDefinition(this.#config.cameraModel).wakeWindowMs
		this.#wakeWindow = {
			silent: false,
			said: false,
			lasts,
			timer: setTimeout(() => {
				const silent = this.#wakeWindow?.silent === true
				this.#wakeWindow = null
				if (!silent) return

				// The camera ought to have answered by now.
				this.log('warn', `Camera didn't answer within ${lasts / 1000} s of being told to power on`)
				this.#showStatus(InstanceStatus.ConnectionFailure)
			}, lasts),
		}
	}

	#wakeWindowEnds(): void {
		if (this.#wakeWindow === null) return
		clearTimeout(this.#wakeWindow.timer)
		this.#wakeWindow = null
	}

	/**
	 * Note that the camera can't be reached or didn't answer.
	 *
	 * @returns
	 *    Whether that's expected of the camera, because it's waking.
	 */
	#silentWhileWaking(): boolean {
		const wakeWindow = this.#wakeWindow
		if (wakeWindow === null) return false

		wakeWindow.silent = true
		if (!wakeWindow.said) {
			wakeWindow.said = true
			this.log('info', `Camera is waking: it may not answer for up to ${wakeWindow.lasts / 1000} s`)
		}
		return true
	}

	/**
	 * Note that the camera answered a polled inquiry: it's awake, and it's
	 * there and connected, whatever was last reported.
	 */
	#cameraAnswered(): void {
		this.#wakeWindowEnds()
		if (this.#connected && this.#statusShown !== InstanceStatus.Ok) {
			this.#showStatus(InstanceStatus.Ok)
		}
	}

	#showStatus(status: InstanceStatus, message?: string | null): void {
		this.#statusShown = status
		super.updateStatus(status, message)
	}

	/**
	 * Report the connection status to Companion.  Only the port calls this,
	 * and it reports ok when, and only when, it has made a connection: so
	 * also keep track of the connection here.
	 *
	 * In the wake window, a connection the port reports failed is reported as
	 * being made.  One the port has made anew, to a camera found silent, is
	 * reported so too until the camera answers a polled inquiry on it, or at
	 * once if nothing is polled.
	 */
	override updateStatus(status: InstanceStatus, message?: string | null): void {
		this.#connected = status === InstanceStatus.Ok
		if (this.#connected) {
			this.#connectionsMade++
			this.#poller.noteConnected()
		}

		const wakeWindow = this.#wakeWindow
		if (wakeWindow !== null) {
			if (status === InstanceStatus.ConnectionFailure) {
				this.#silentWhileWaking()
				status = InstanceStatus.Connecting
			} else if (status === InstanceStatus.Ok) {
				if (wakeWindow.silent && this.#poller.polling) {
					status = InstanceStatus.Connecting
				} else {
					wakeWindow.silent = false
				}
			}
			if (status === this.#statusShown) return
		}
		this.#showStatus(status, message)
	}

	/**
	 * Log a message.  In the wake window, a network error the port logs is
	 * what a waking camera is expected to cause, so it's logged for debugging
	 * only.
	 */
	override log(level: LogLevel, message: string): void {
		if (level === 'error' && message.startsWith('Network error: ') && this.#silentWhileWaking()) {
			level = 'debug'
		}
		super.log(level, message)
	}

	/** Polls the camera for status, if enabled in config. */
	#poller = new StatusPoller({
		canPoll: () => !this.#visca.closed,
		inquire: async (inquiry, probe) => this.#pollInquiry(inquiry, probe),
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

	/**
	 * A promise that resolves when the inquiry the status poller is waiting on
	 * has been answered, or can no longer be; null if there's no such inquiry.
	 */
	#polledInquiryAnswered: Promise<void> | null = null

	/**
	 * A promise that resolves when every command held back behind a polled
	 * inquiry has been sent; null if no command is held back.
	 */
	#commandsHeldBack: Promise<void> | null = null

	/**
	 * Send an inquiry for the status poller.
	 *
	 * If the camera doesn't answer it within `InquiryProbeAfterMs` of its
	 * being sent, find out whether the camera is still there by sending it
	 * `probe`, if there is one.  The port tells an answer to the one from an
	 * answer to the other, and the camera answers in order: so an answer to
	 * the probe shows that the camera ignored the inquiry, and the connection
	 * is kept.
	 *
	 * If the camera answers nothing within `InquiryTimeoutMs` of the inquiry's
	 * being sent, take the connection for lost and reconnect, just as after a
	 * network error.
	 *
	 * A camera in standby refuses most inquiries with an error that doesn't
	 * say which message it refuses, and the port attributes that error to a
	 * command awaiting its initial response if there is one.  So don't send
	 * the inquiry until every command sent has been acknowledged, within
	 * `OverlapWaitLimitMs`; `sendCommand` in turn holds a command back while
	 * the inquiry is unanswered.
	 *
	 * @param inquiry
	 *    The inquiry to send.
	 * @param probe
	 *    An inquiry the camera is expected to answer, whose answer can't be
	 *    mistaken for an answer to `inquiry`; or null if there's none, and
	 *    then an inquiry the camera ignores can't be told from a camera gone.
	 * @returns
	 *    The answer; an error if the camera answered anything else;
	 *    `'ignored'` if the camera answered the probe and not the inquiry;
	 *    `'unanswered'` if the camera was sent the inquiry and answered
	 *    nothing in time; or null if the connection was lost before the
	 *    inquiry could be sent or an answer came.
	 */
	async #pollInquiry(
		inquiry: Inquiry<AnswerParameters>,
		probe: Inquiry<AnswerParameters> | null,
	): Promise<Answer<AnswerParameters> | Error | 'ignored' | 'unanswered' | null> {
		// Don't count time spent waiting for a connection against the camera.
		try {
			await this.#visca.connect()
		} catch {
			return null
		}

		while (this.#commandsHeldBack !== null) {
			await this.#commandsHeldBack
		}
		await resolvedWithin(this.#visca.commandsAcknowledged(), OverlapWaitLimitMs)

		// The connection may have been lost meanwhile.  The camera can't
		// answer, or refuse, an inquiry that can't be sent to it.
		if (!this.#connected) {
			return null
		}
		const connection = this.#connectionsMade

		const { promise: inquiryAnswered, resolve: inquiryNoLongerPending } = Promise.withResolvers<void>()
		this.#polledInquiryAnswered = inquiryAnswered
		try {
			// With a connection made, the port writes the inquiry's bytes to
			// it before `sendInquiry` returns, so the camera's time starts
			// now.  A pending inquiry rejects when its connection closes.
			const answered = this.#visca.sendInquiry(inquiry).catch(() => null)
			let result: Answer<AnswerParameters> | Error | 'ignored' | 'unanswered' | null = await unlessUnansweredWithin(
				answered,
				probe === null ? InquiryTimeoutMs : InquiryProbeAfterMs,
			)

			if (result === 'unanswered' && probe !== null) {
				await resolvedWithin(this.#visca.commandsAcknowledged(), OverlapWaitLimitMs)
				if (this.#connected && connection === this.#connectionsMade) {
					this.#visca.abandonInquiry(inquiry)
					const probed = await unlessUnansweredWithin(
						this.#visca.sendInquiry(probe).catch(() => null),
						InquiryTimeoutMs - InquiryProbeAfterMs,
					)
					if (probed !== null && probed !== 'unanswered') {
						// The port settled the inquiry before the probe:
						// with its answer if that came late, ahead of the
						// probe's, and with an error if not.
						const late = await answered
						result = late === null || late instanceof Error ? 'ignored' : late
					} else {
						// The connection was lost, or the camera is gone.
						result = probed
					}
				}
			}

			if (result === 'unanswered') {
				// Leave alone a connection the inquiry wasn't sent on: the
				// module may have been destroyed or given another camera
				// since.
				if (!this.#connected || connection !== this.#connectionsMade) {
					return null
				}

				if (!this.#silentWhileWaking()) {
					this.log('warn', `Camera didn't answer a status inquiry within ${InquiryTimeoutMs} ms; reconnecting`)
				}
				this.#visca.close('Camera stopped answering', InstanceStatus.ConnectionFailure)
				const { host, port } = this.#config
				if (isValidHost(host)) this.#visca.open(host, port)
				return result
			}

			// Even a refusal is an answer, and so is an answer to the probe.
			if (result !== null) this.#cameraAnswered()
			return result
		} finally {
			this.#polledInquiryAnswered = null
			inquiryNoLongerPending()
		}
	}

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
		this.#sendCommandThen(command, paramValues, null)
	}

	/**
	 * Tell the camera to power on or to go to standby.
	 *
	 * A camera told to power on may answer nothing for a while once it has
	 * acknowledged that, unless it was on already: see `#wakeWindow`.
	 */
	setPower(state: CameraPowerState): void {
		const wakes =
			state === CameraPowerState.On && (this.#toldToStandby || this.#status.get('power') !== CameraPowerState.On)
		this.#toldToStandby = state === CameraPowerState.Standby
		this.#sendCommandThen(
			CameraPower,
			[{ state }],
			wakes
				? () => {
						this.#wakeWindowStarts()
					}
				: null,
		)
	}

	/**
	 * Send the given command to the camera as `sendCommand` does, then call
	 * the given function, if any, once the camera has completed the command.
	 */
	#sendCommandThen<CmdParameters extends CommandParameters>(
		command: Command<CmdParameters>,
		paramValues: CmdParameters extends NoCommandParameters
			? [CommandParamValues<CmdParameters>?]
			: [CommandParamValues<CmdParameters>],
		completed: (() => void) | null,
	): void {
		this.#poller.noteActivity()

		const send = () => {
			// `sendCommand` implicitly waits for the connection to be fully
			// established, so it's unnecessary to resolve
			// `this.#visca.connect()` here.
			this.#visca.sendCommand(command, ...paramValues).then(
				(result: void | Error) => {
					if (typeof result === 'undefined') {
						completed?.()
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

		// If the camera refuses a polled inquiry while this command awaits its
		// initial response, the port attributes the refusal to this command
		// (see `#pollInquiry`).  So hold the command back until the inquiry is
		// answered, but only briefly: a camera that has stopped answering
		// mustn't stop a command being sent.  Commands already held back go
		// first, to keep commands in order.
		let wait = this.#commandsHeldBack
		if (wait === null) {
			if (this.#polledInquiryAnswered === null) {
				send()
				return
			}
			wait = resolvedWithin(this.#polledInquiryAnswered, OverlapWaitLimitMs)
		}

		const sent = wait.then(send)
		this.#commandsHeldBack = sent
		void sent.then(() => {
			if (this.#commandsHeldBack === sent) {
				this.#commandsHeldBack = null
			}
		})
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
		this.#wakeWindowEnds()
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
			camera: cameraDefinition(config.cameraModel),
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

		// Whatever camera is connected to next wasn't told to power on.
		this.#wakeWindowEnds()

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
