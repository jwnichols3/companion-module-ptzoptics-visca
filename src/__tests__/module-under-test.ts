import type { CompanionOptionValues, CompanionVariableValue, InstanceStatus, LogLevel } from '@companion-module/base'
import type { RawConfig, RawSecrets } from '../config.js'
import { PtzOpticsInstance } from '../instance.js'
import { UpgradeScripts } from '../upgrades.js'
import { repr } from '../utils/repr.js'

/**
 * A message of the protocol a module instance and Companion speak over the
 * process's IPC channel: a call (with a callback id if it expects a response)
 * or the response to a call.
 */
type IpcMessage =
	| {
			readonly direction: 'call'
			readonly name: string
			readonly payload: string
			readonly callbackId: number | undefined
	  }
	| {
			readonly direction: 'response'
			readonly callbackId: number
			readonly success: boolean
			/** Absent when the call resolved nothing. */
			readonly payload: string | undefined
	  }

function isIpcMessage(message: unknown): message is IpcMessage {
	return typeof message === 'object' && message !== null && 'direction' in message
}

type ResponseWaiter = {
	readonly resolve: (payload: unknown) => void
	readonly reject: (err: Error) => void
}

/** Receives messages the instance sends to Companion, for the module currently under test. */
let receiveFromInstance: ((msg: IpcMessage) => void) | null = null

let sendIntercepted = false

/**
 * `InstanceBase` talks to Companion through `process.send`.  Divert the
 * messages it sends to the module under test, and pass along anything else
 * (the test runner may use the same channel) untouched.
 *
 * The interception is never undone, so that a message sent by an instance
 * after its test finished can't reach the test runner.
 */
function interceptProcessSend(): void {
	if (sendIntercepted) {
		return
	}
	sendIntercepted = true

	const originalSend = process.send?.bind(process)
	process.send = (message: unknown, ...args: any[]): boolean => {
		if (isIpcMessage(message)) {
			receiveFromInstance?.(message)
			return true
		}

		return originalSend?.(message, ...args) ?? true
	}
}

/**
 * The whole module -- the real `PtzOpticsInstance`, so the real status poller
 * joined to the real `VISCAPort` -- driven the way Companion drives it, with
 * this class standing in for Companion: settings and actions go in, and the
 * connection status, variable values, and log lines the module reports can be
 * read back.
 *
 * Only one module can be under test at a time.
 */
export class ModuleUnderTest {
	/** Deliver a message to the instance as if Companion had sent it. */
	readonly #sendToInstance: (msg: IpcMessage) => void

	#nextCallbackId = 1
	readonly #responseWaiters = new Map<number, ResponseWaiter>()

	readonly #variables = new Map<string, CompanionVariableValue | undefined>()

	/** Every status the module has reported, oldest first. */
	readonly statuses: InstanceStatus[] = []

	/** Every line the module has logged, oldest first. */
	readonly logs: { readonly level: LogLevel; readonly message: string }[] = []

	/** Called with each line the module logs, as it's logged, if set: for a test that times what's logged. */
	onLog: ((message: string) => void) | null = null

	private constructor() {
		interceptProcessSend()
		receiveFromInstance = (msg) => {
			this.#receivedFromInstance(msg)
		}

		// The instance listens for Companion's messages on `process`.  Take
		// that listener for ourselves, so that this class is the only source
		// of messages to the instance.
		const listenersBefore = process.listeners('message')
		new PtzOpticsInstance({ id: 'module-under-test', upgradeScripts: UpgradeScripts, _isInstanceBaseProps: true })
		const listeners = process.listeners('message').filter((listener) => !listenersBefore.includes(listener))
		if (listeners.length !== 1) {
			throw new Error(`Expected the instance to add one message listener, got ${listeners.length}`)
		}
		const [listener] = listeners
		process.off('message', listener)
		this.#sendToInstance = (msg) => {
			listener(msg, undefined)
		}
	}

	/**
	 * Create the module and initialize it with the given config, as Companion
	 * does when a connection is enabled.  Missing config options take their
	 * defaults.
	 */
	static async start(config: RawConfig, secrets: RawSecrets = {}): Promise<ModuleUnderTest> {
		const module = new ModuleUnderTest()
		await module.#call('init', {
			label: 'module-under-test',
			isFirstInit: false,
			config,
			secrets,
			lastUpgradeIndex: UpgradeScripts.length - 1,
			feedbacks: {},
			actions: {},
		})
		return module
	}

	/** The most recent connection status the module reported, if any. */
	get status(): InstanceStatus | undefined {
		return this.statuses.at(-1)
	}

	/** The current value of the given variable. */
	variable(id: string): CompanionVariableValue | undefined {
		return this.#variables.get(id)
	}

	/** Run an action, as when a button with that action is pressed. */
	async executeAction(actionId: string, options: CompanionOptionValues = {}): Promise<void> {
		await this.#call('executeAction', {
			action: {
				id: 'action-under-test',
				controlId: 'control-under-test',
				actionId,
				options,
				upgradeIndex: null,
				disabled: false,
			},
			surfaceId: undefined,
		})
	}

	/** Destroy the module, as Companion does when a connection is disabled. */
	async destroy(): Promise<void> {
		await this.#call('destroy', {})
	}

	/** Call the instance and resolve its response. */
	async #call(name: string, payload: unknown): Promise<unknown> {
		const callbackId = this.#nextCallbackId++
		const response = new Promise<unknown>((resolve, reject) => {
			this.#responseWaiters.set(callbackId, { resolve, reject })
		})
		this.#sendToInstance({ direction: 'call', name, payload: JSON.stringify(payload), callbackId })
		return response
	}

	/** Handle a message the instance sent to Companion. */
	#receivedFromInstance(msg: IpcMessage): void {
		const payload: any = msg.payload === undefined ? undefined : JSON.parse(msg.payload)

		if (msg.direction === 'response') {
			const waiter = this.#responseWaiters.get(msg.callbackId)
			this.#responseWaiters.delete(msg.callbackId)
			if (msg.success) {
				waiter?.resolve(payload)
			} else {
				waiter?.reject(new Error(`Module call failed: ${repr(payload?.message)}`))
			}
			return
		}

		switch (msg.name) {
			case 'set-status':
				this.statuses.push(payload.status)
				break
			case 'log-message':
				this.logs.push({ level: payload.level, message: payload.message })
				this.onLog?.(payload.message)
				break
			case 'setVariableDefinitions':
			case 'setVariableValues':
				for (const { id, value } of payload.newValues) {
					this.#variables.set(id, value)
				}
				break
			default:
				// Definitions, feedback values, and the like: not observed.
				break
		}
	}
}
