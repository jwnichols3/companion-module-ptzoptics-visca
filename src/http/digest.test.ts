import { describe, expect, test } from 'vitest'
import { DigestClient, digestAuthorization, type FetchLike, parseCgi, parseDigestChallenge } from './digest.js'
import { deviceConfValues, imageConfValues } from './http-status.js'

// RFC 7616 section 3.9.1 example.
const Rfc = {
	header:
		'Digest realm="http-auth@example.org", qop="auth, auth-int", algorithm=SHA-256, ' +
		'nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"',
	args: {
		username: 'Mufasa',
		password: 'Circle of Life',
		method: 'GET',
		uri: '/dir/index.html',
		nc: 1,
		cnonce: 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ',
	},
}

describe('digest auth', () => {
	test('RFC 7616 SHA-256 example', () => {
		const c = parseDigestChallenge(Rfc.header)
		expect(c).not.toBeNull()
		expect(digestAuthorization(c!, Rfc.args)).toContain(
			'response="753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1"',
		)
	})

	test('RFC 7616 MD5 example', () => {
		const c = parseDigestChallenge(Rfc.header.replace('SHA-256', 'MD5'))
		expect(digestAuthorization(c!, Rfc.args)).toContain('response="8ca523f5e9506fed4657c9700eebdbec"')
	})

	test('parses the PTZOptics challenge', () => {
		expect(
			parseDigestChallenge(
				'Digest realm="ignored-for-authn-tkt", charset="UTF-8", algorithm="SHA-256", nonce="6b02e104:1e12", qop="auth"',
			),
		).toEqual({
			realm: 'ignored-for-authn-tkt',
			nonce: '6b02e104:1e12',
			qop: 'auth',
			algorithm: 'SHA-256',
			opaque: null,
		})
	})

	test('rejects non-digest challenges', () => {
		expect(parseDigestChallenge('Basic realm="x"')).toBeNull()
		expect(parseDigestChallenge(null)).toBeNull()
	})

	test('client answers a challenge, then reports a rejected login', async () => {
		const challenge = 'Digest realm="r", algorithm=SHA-256, nonce="n", qop="auth"'
		const seen: (string | undefined)[] = []
		const make =
			(okAuth: boolean): FetchLike =>
			async (_url, { headers }) => {
				seen.push(headers['Authorization'])
				const ok = okAuth && headers['Authorization'] !== undefined
				return {
					status: ok ? 200 : 401,
					headers: { get: () => (ok ? null : challenge) },
					text: async () => (ok ? 'devname="cam"\n' : ''),
				}
			}

		expect(await new DigestClient('u', 'p', { fetch: make(true) }).get('http://cam/cgi-bin/x?y')).toBe(
			'devname="cam"\n',
		)
		expect(seen[1]).toMatch(/uri="\/cgi-bin\/x\?y".*nc=00000001/)
		await expect(new DigestClient('u', 'bad', { fetch: make(false) }).get('http://cam/')).rejects.toThrow(
			'rejected the username or password',
		)
	})
})

describe('camera CGI answers', () => {
	// Excerpts of real answers (2026-11-22).
	const image = parseCgi(
		'bright="7"\nndi_mode="medium"\nhdmivideoformat="1080P30"\npt_moving="0"\nzoom_moving="1"\nfocus_moving="0"\nautotrack="0"\npreset="-2"\n',
	)
	const device = parseCgi(
		'devname="rocket-ptz-b-se"\nversioninfo="SOC v9.1.34"\nserial_num="x"\ndevice_model=" F64.HI "\n',
	)

	test('image conf', () => {
		expect(imageConfValues(image)).toEqual({
			pt_moving: 'false',
			zoom_moving: 'true',
			focus_moving: 'false',
			moving: 'true',
			autotrack: 'off',
			camera_preset: -2,
			video_format: '1080P30',
			ndi_mode: 'medium',
		})
	})

	test('device conf (no serial number exposed)', () => {
		expect(deviceConfValues(device)).toEqual({
			device_name: 'rocket-ptz-b-se',
			model: 'F64.HI',
			firmware: 'SOC v9.1.34',
		})
	})

	test('missing fields are left out', () => {
		expect(imageConfValues({})).toEqual({})
	})
})
