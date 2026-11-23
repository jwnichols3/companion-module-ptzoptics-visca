import type { CompanionVariableDefinition, CompanionVariableValues, LogLevel } from '@companion-module/base'
import { AuthError, DigestClient, type FetchLike, parseCgi } from './digest.js'

/**
 * Status read from the camera's web (HTTP CGI) interface, which needs the
 * camera's login.  Only read-only `get_*` requests are sent.  Network config
 * is never requested: it contains stream keys.
 */
export const HttpVariables: CompanionVariableDefinition[] = [
	{ variableId: 'http_status', name: 'Camera web login status (ok, login rejected, unreachable)' },
	{ variableId: 'device_name', name: 'Camera device name' },
	{ variableId: 'model', name: 'Camera model' },
	{ variableId: 'firmware', name: 'Camera firmware version' },
	{ variableId: 'moving', name: 'Camera is moving: pan/tilt, zoom or focus (true, false)' },
	{ variableId: 'pt_moving', name: 'Pan/tilt is moving (true, false)' },
	{ variableId: 'zoom_moving', name: 'Zoom is moving (true, false)' },
	{ variableId: 'focus_moving', name: 'Focus is moving (true, false)' },
	{ variableId: 'autotrack', name: 'Auto-tracking (on, off)' },
	{ variableId: 'camera_preset', name: 'Preset the camera reports (-2 = none; meaning varies by firmware)' },
	{ variableId: 'video_format', name: 'HDMI/SDI output video format' },
	{ variableId: 'ndi_mode', name: 'NDI mode' },
]

type HttpStatusSettings = {
	readonly enabled: boolean
	readonly host: string
	readonly port: number
	readonly username: string
	readonly password: string
	readonly interval: number
}

interface HttpStatusTarget {
	setVariableValues(values: CompanionVariableValues): void
	log(level: LogLevel, message: string): void
}

const bool = (v: string | undefined) => (v === undefined ? undefined : v !== '0' ? 'true' : 'false')

/** Map the camera's `get_image_conf` answer to variable values. */
export function imageConfValues(conf: Record<string, string>): CompanionVariableValues {
	const pt = bool(conf['pt_moving'])
	const zoom = bool(conf['zoom_moving'])
	const focus = bool(conf['focus_moving'])
	const values: CompanionVariableValues = {
		pt_moving: pt,
		zoom_moving: zoom,
		focus_moving: focus,
		moving:
			pt === undefined && zoom === undefined && focus === undefined
				? undefined
				: String([pt, zoom, focus].includes('true')),
		autotrack: conf['autotrack'] === undefined ? undefined : conf['autotrack'] === '0' ? 'off' : 'on',
		camera_preset: conf['preset'] === undefined ? undefined : Number(conf['preset']),
		video_format: conf['hdmivideoformat'],
		ndi_mode: conf['ndi_mode'],
	}
	return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined))
}

/** Map the camera's `get_device_conf` answer to variable values. */
export function deviceConfValues(conf: Record<string, string>): CompanionVariableValues {
	const values: CompanionVariableValues = {
		device_name: conf['devname'],
		model: conf['device_model']?.trim(),
		firmware: conf['versioninfo'],
	}
	return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined))
}

/** Polls the camera's web interface on a timer. */
export class HttpStatusPoller {
	readonly #target: HttpStatusTarget
	readonly #fetch: FetchLike | undefined
	#client: DigestClient | null = null
	#settings: HttpStatusSettings | null = null
	#timer: ReturnType<typeof setTimeout> | null = null
	#generation = 0
	#haveDevice = false
	#status = ''
	#last = new Map<string, unknown>()

	constructor(target: HttpStatusTarget, fetchImpl?: FetchLike) {
		this.#target = target
		this.#fetch = fetchImpl
	}

	configure(settings: HttpStatusSettings): void {
		this.stop()
		this.#settings = settings
		this.#haveDevice = false
		this.#status = ''
		this.#last.clear()
		if (!settings.enabled || settings.host === '') return
		this.#client = new DigestClient(settings.username, settings.password, this.#fetch ? { fetch: this.#fetch } : {})
		this.#schedule(0)
	}

	stop(): void {
		this.#generation++
		if (this.#timer !== null) clearTimeout(this.#timer)
		this.#timer = null
		this.#client = null
	}

	/** Run one poll.  Exposed for tests. */
	async pollOnce(): Promise<void> {
		const client = this.#client
		const s = this.#settings
		if (client === null || s === null) return

		const base = `http://${s.host}:${s.port}/cgi-bin`
		try {
			const values: CompanionVariableValues = {}
			if (!this.#haveDevice) {
				Object.assign(values, deviceConfValues(parseCgi(await client.get(`${base}/param.cgi?get_device_conf`))))
				this.#haveDevice = true
			}
			Object.assign(values, imageConfValues(parseCgi(await client.get(`${base}/param.cgi?get_image_conf`))))
			this.#setStatus('ok')
			this.#publish(values)
		} catch (e) {
			if (e instanceof AuthError) {
				this.#setStatus('login rejected', e.message)
			} else {
				this.#setStatus('unreachable', e instanceof Error ? e.message : String(e))
			}
		}
	}

	#setStatus(status: string, detail?: string): void {
		if (status === this.#status) return
		this.#status = status
		this.#target.log(
			status === 'ok' ? 'info' : 'warn',
			`Camera web status: ${status}${detail !== undefined ? ` (${detail})` : ''}`,
		)
		this.#publish({ http_status: status })
	}

	#publish(values: CompanionVariableValues): void {
		const changed: CompanionVariableValues = {}
		let any = false
		for (const [k, v] of Object.entries(values)) {
			if (this.#last.get(k) !== v) {
				this.#last.set(k, v)
				changed[k] = v
				any = true
			}
		}
		if (any) this.#target.setVariableValues(changed)
	}

	#schedule(delay: number): void {
		const generation = this.#generation
		this.#timer = setTimeout(() => {
			this.#timer = null
			void this.pollOnce().finally(() => {
				if (generation !== this.#generation || this.#settings === null) return
				// Back off while the login is rejected; there's no point hammering it.
				const delay = this.#status === 'login rejected' ? 30000 : this.#settings.interval
				this.#schedule(delay)
			})
		}, delay)
	}
}
