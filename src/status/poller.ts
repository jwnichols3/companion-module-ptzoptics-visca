import type { CompanionVariableDefinition, CompanionVariableValues, LogLevel } from '@companion-module/base'
import type { Answer, AnswerParameters, Inquiry } from '../visca/inquiry.js'
import { type PolledInquiry, type PollGroupId, PollGroups } from './groups.js'

/** What the poller needs from the module instance. */
export interface PollTarget {
	/** Whether a connection to the camera exists or is being established. */
	canPoll(): boolean
	/** Send an inquiry, resolving its answer or an error, without logging. */
	inquire(inquiry: Inquiry<AnswerParameters>): Promise<Answer<AnswerParameters> | Error>
	setVariableValues(values: CompanionVariableValues): void
	/** Called after each pass with whether the camera answered anything. */
	passCompleted(answered: boolean): void
	log(level: LogLevel, message: string): void
}

type PollSettings = {
	readonly enabled: boolean
	/** Milliseconds between the end of one poll pass and the start of the next. */
	readonly interval: number
	readonly groups: readonly PollGroupId[]
	readonly zoomMax: number
}

/** After a command is sent, poll quickly for this long so controls feel live. */
const FastPollWindowMs = 2000
export const FastPollIntervalMs = 200

/** Variables for the selected poll groups. */
export function pollVariableDefinitions(groups: readonly PollGroupId[]): CompanionVariableDefinition[] {
	return PollGroups.filter((g) => groups.includes(g.id)).flatMap((g) => g.variables)
}

/**
 * Periodically sends status inquiries to the camera and publishes the answers
 * as variable values, publishing only values that changed.
 *
 * An inquiry that fails while other inquiries in the same pass succeed is
 * assumed unsupported by this camera and is dropped until settings change.
 * If every inquiry in a pass fails, the camera is probably unreachable, so
 * nothing is dropped.
 */
export class StatusPoller {
	readonly #target: PollTarget
	#settings: PollSettings = { enabled: false, interval: 1000, groups: [], zoomMax: 0x4000 }
	#inquiries: PolledInquiry[] = []
	#unsupported = new Set<string>()
	#lastValues = new Map<string, string | number | boolean | undefined>()
	#timer: ReturnType<typeof setTimeout> | null = null
	#running = false
	#fastUntil = 0
	#generation = 0

	constructor(target: PollTarget) {
		this.#target = target
	}

	/** Apply new settings, restarting polling if enabled. */
	configure(settings: PollSettings): void {
		this.stop()
		this.#settings = settings
		this.#inquiries = PollGroups.filter((g) => settings.groups.includes(g.id)).flatMap((g) => g.inquiries)
		this.#unsupported.clear()
		this.#lastValues.clear()
		if (settings.enabled && this.#inquiries.length > 0) {
			this.#running = true
			this.#schedule(0)
		}
	}

	/** Stop polling.  Any pass in progress finishes without scheduling another. */
	stop(): void {
		this.#running = false
		this.#generation++
		if (this.#timer !== null) {
			clearTimeout(this.#timer)
			this.#timer = null
		}
	}

	/**
	 * Note that the camera was just told to move, so that polling speeds up
	 * briefly, and poll again soon.
	 */
	noteActivity(now = Date.now()): void {
		if (!this.#running) return
		const wasFast = now < this.#fastUntil
		this.#fastUntil = now + FastPollWindowMs
		if (!wasFast && this.#timer !== null) {
			clearTimeout(this.#timer)
			this.#schedule(FastPollIntervalMs)
		}
	}

	/** Run one pass now (also usable when polling is disabled). */
	async pollOnce(): Promise<void> {
		if (!this.#target.canPoll()) return

		const ctx = { zoomMax: this.#settings.zoomMax }
		const failed: PolledInquiry[] = []
		let succeeded = 0
		const changed: CompanionVariableValues = {}
		let anyChanged = false

		for (const polled of this.#inquiries) {
			if (this.#unsupported.has(polled.id)) continue

			const result = await this.#target.inquire(polled.inquiry)
			if (result instanceof Error) {
				failed.push(polled)
				continue
			}

			succeeded++
			for (const [id, value] of Object.entries(polled.toValues(result, ctx))) {
				if (this.#lastValues.get(id) !== value) {
					this.#lastValues.set(id, value)
					changed[id] = value
					anyChanged = true
				}
			}
		}

		if (succeeded > 0) {
			for (const { id } of failed) {
				this.#unsupported.add(id)
				this.#target.log('info', `Camera didn't answer the "${id}" status inquiry; no longer polling it`)
			}
		}

		if (anyChanged) {
			this.#target.setVariableValues(changed)
		}
		this.#target.passCompleted(succeeded > 0 || this.#inquiries.every(({ id }) => this.#unsupported.has(id)))
	}

	#schedule(delay: number): void {
		const generation = this.#generation
		this.#timer = setTimeout(() => {
			this.#timer = null
			void this.pollOnce()
				.catch((e: unknown) => {
					this.#target.log('error', `Status poll failed: ${String(e)}`)
				})
				.finally(() => {
					if (!this.#running || generation !== this.#generation) return
					const fast = Date.now() < this.#fastUntil
					this.#schedule(fast ? Math.min(FastPollIntervalMs, this.#settings.interval) : this.#settings.interval)
				})
		}, delay)
	}
}
