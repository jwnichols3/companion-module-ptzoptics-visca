import { createHash, randomBytes } from 'node:crypto'

/** The parts of a `WWW-Authenticate: Digest ...` challenge this client uses. */
type DigestChallenge = {
	realm: string
	nonce: string
	qop: string | null
	algorithm: 'MD5' | 'SHA-256'
	opaque: string | null
}

/** Parse a `WWW-Authenticate` header value, or return null if it isn't a usable Digest challenge. */
export function parseDigestChallenge(header: string | null): DigestChallenge | null {
	if (header === null || !/^\s*Digest\s/i.test(header)) return null

	const params: Record<string, string> = {}
	const re = /(\w+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g
	let m
	while ((m = re.exec(header)) !== null) {
		params[m[1].toLowerCase()] = m[2] ?? m[3]
	}

	const algorithm = (params['algorithm'] ?? 'MD5').toUpperCase()
	if ((algorithm !== 'MD5' && algorithm !== 'SHA-256') || params['realm'] === undefined || !params['nonce']) {
		return null
	}

	let qop: string | null = null
	if (params['qop'] !== undefined) {
		const offered = params['qop'].split(',').map((q) => q.trim())
		if (!offered.includes('auth')) return null
		qop = 'auth'
	}

	return { realm: params['realm'], nonce: params['nonce'], qop, algorithm, opaque: params['opaque'] ?? null }
}

/** Compute an `Authorization` header value answering `challenge` (RFC 7616). */
export function digestAuthorization(
	challenge: DigestChallenge,
	{
		username,
		password,
		method,
		uri,
		nc,
		cnonce,
	}: {
		username: string
		password: string
		method: string
		uri: string
		nc: number
		cnonce: string
	},
): string {
	const h = (s: string) =>
		createHash(challenge.algorithm === 'SHA-256' ? 'sha256' : 'md5')
			.update(s)
			.digest('hex')
	const ha1 = h(`${username}:${challenge.realm}:${password}`)
	const ha2 = h(`${method}:${uri}`)
	const ncHex = nc.toString(16).padStart(8, '0')
	const response =
		challenge.qop === null
			? h(`${ha1}:${challenge.nonce}:${ha2}`)
			: h(`${ha1}:${challenge.nonce}:${ncHex}:${cnonce}:${challenge.qop}:${ha2}`)

	const parts = [
		`username="${username}"`,
		`realm="${challenge.realm}"`,
		`nonce="${challenge.nonce}"`,
		`uri="${uri}"`,
		`algorithm=${challenge.algorithm}`,
		`response="${response}"`,
	]
	if (challenge.qop !== null) parts.push(`qop=${challenge.qop}`, `nc=${ncHex}`, `cnonce="${cnonce}"`)
	if (challenge.opaque !== null) parts.push(`opaque="${challenge.opaque}"`)
	return `Digest ${parts.join(', ')}`
}

export type FetchLike = (
	url: string,
	init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{
	status: number
	headers: { get(name: string): string | null }
	text(): Promise<string>
}>

export class AuthError extends Error {}

/**
 * Makes GET requests with HTTP Digest authentication, reusing the last
 * challenge (with an increasing nonce count) until the server rejects it.
 */
export class DigestClient {
	readonly #fetch: FetchLike
	readonly #username: string
	readonly #password: string
	readonly #timeoutMs: number
	#challenge: DigestChallenge | null = null
	#nc = 0

	constructor(
		username: string,
		password: string,
		{ fetch: f, timeoutMs = 3000 }: { fetch?: FetchLike; timeoutMs?: number } = {},
	) {
		this.#username = username
		this.#password = password
		this.#fetch = f ?? fetch
		this.#timeoutMs = timeoutMs
	}

	/** GET `url`, returning the body.  Throws `AuthError` if the login is rejected. */
	async get(url: string): Promise<string> {
		for (let attempt = 0; attempt < 2; attempt++) {
			const headers: Record<string, string> = {}
			if (this.#challenge !== null) {
				const { pathname, search } = new URL(url)
				headers['Authorization'] = digestAuthorization(this.#challenge, {
					username: this.#username,
					password: this.#password,
					method: 'GET',
					uri: pathname + search,
					nc: ++this.#nc,
					cnonce: randomBytes(12).toString('hex'),
				})
			}

			const res = await this.#fetch(url, { headers, signal: AbortSignal.timeout(this.#timeoutMs) })
			if (res.status !== 401) {
				const body = await res.text()
				if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} from ${url}`)
				return body
			}

			await res.text().catch(() => '')
			const challenge = parseDigestChallenge(res.headers.get('www-authenticate'))
			if (challenge === null) throw new AuthError('Camera asked for a login method this module does not support')
			// A fresh challenge after we already answered one means the login was wrong.
			if (headers['Authorization'] !== undefined && attempt === 1) break
			this.#challenge = challenge
			this.#nc = 0
		}
		throw new AuthError('Camera rejected the username or password')
	}
}

/** Parse the camera's CGI `key="value"` lines. */
export function parseCgi(body: string): Record<string, string> {
	const out: Record<string, string> = {}
	for (const line of body.split(/\r?\n/)) {
		const m = /^\s*([\w.]+)\s*=\s*"(.*)"\s*$/.exec(line)
		if (m) out[m[1]] = m[2]
	}
	return out
}
