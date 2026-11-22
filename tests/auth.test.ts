import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { auth } from '@elysia/middlewares/auth.middleware';
import { createAuth } from '@lib/auth';
import { jose } from '@rniverse/utils';
import Elysia from 'elysia';

type Payload = { sub: string; fid: string };

const ISSUER = 'http://auth.local';
let privateKey: CryptoKey;
let publicPEM: string;
let jwk: Record<string, unknown>;

async function sign(
	payload: Payload,
	options: { issuer?: string; expired?: boolean; kid?: string } = {},
) {
	return new jose.SignJWT(payload)
		.setProtectedHeader({ alg: 'RS256', kid: options.kid ?? 'key-1' })
		.setIssuedAt()
		.setIssuer(options.issuer ?? ISSUER)
		.setExpirationTime(
			options.expired ? Math.floor(Date.now() / 1000) - 60 : '5m',
		)
		.sign(privateKey);
}

// A local JWKS endpoint, standing in for aham's /.well-known/jwks.json.
let server: ReturnType<typeof Bun.serve>;
let jwksURL: string;

beforeAll(async () => {
	const pair = await jose.generateKeyPair('RS256', { extractable: true });
	privateKey = pair.privateKey as CryptoKey;
	publicPEM = await jose.exportSPKI(pair.publicKey);
	jwk = {
		...(await jose.exportJWK(pair.publicKey)),
		kid: 'key-1',
		alg: 'RS256',
		use: 'sig',
	};
	server = Bun.serve({
		port: 0,
		fetch: () => Response.json({ keys: [jwk] }),
	});
	jwksURL = `http://localhost:${server.port}/.well-known/jwks.json`;
});

afterAll(() => server.stop(true));

const user: Payload = { sub: 'user-1', fid: 'family-1' };

describe('lib/auth — bearer', () => {
	const { bearer } = createAuth<Payload>({
		source: { key: 'unused' },
		issuer: ISSUER,
	});
	test('strips the Bearer scheme', () => {
		expect(bearer('Bearer abc')).toBe('abc');
	});
	test('anything else is undefined', () => {
		expect(bearer(undefined)).toBeUndefined();
		expect(bearer('Basic abc')).toBeUndefined();
		expect(bearer('Bearer ')).toBeUndefined();
	});
});

describe.each([
	['key', () => ({ key: publicPEM })],
	['jwks', () => ({ jwks: jwksURL })],
] as const)('lib/auth — verify with a %s source', (_, source) => {
	const verifier = () =>
		createAuth<Payload>({ source: source(), issuer: ISSUER });

	test('a good token verifies', async () => {
		const result = await verifier().verify({ token: await sign(user) });
		expect(result).toEqual({ ok: true, data: expect.objectContaining(user) });
	});

	test('no token is missing', async () => {
		expect(await verifier().verify({})).toEqual({
			ok: false,
			error: 'missing',
		});
	});

	test('a wrong issuer, an expired token, garbage are invalid', async () => {
		const v = verifier();
		for (const token of [
			await sign(user, { issuer: 'http://evil.local' }),
			await sign(user, { expired: true }),
			'not.a.jwt',
		]) {
			expect(await v.verify({ token })).toEqual({
				ok: false,
				error: 'invalid',
			});
		}
	});

	test('a token signed by another key is invalid', async () => {
		const other = await jose.generateKeyPair('RS256');
		const token = await new jose.SignJWT(user)
			.setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
			.setIssuer(ISSUER)
			.setExpirationTime('5m')
			.sign(other.privateKey);
		expect(await verifier().verify({ token })).toEqual({
			ok: false,
			error: 'invalid',
		});
	});
});

describe('lib/auth — strict', () => {
	test('the check runs only when strict, and blocks', async () => {
		let checks = 0;
		const v = createAuth<Payload>({
			source: { key: publicPEM },
			issuer: ISSUER,
			check: async (p) => {
				checks++;
				return p.fid === 'family-1';
			},
		});
		const token = await sign(user);
		expect((await v.verify({ token })).ok).toBe(true);
		expect(checks).toBe(0);
		expect(await v.verify({ token, strict: true })).toEqual({
			ok: false,
			error: 'blocked',
		});
	});

	test('strict on an already-verified user skips the signature check', async () => {
		const v = createAuth<Payload>({
			source: { key: publicPEM },
			issuer: ISSUER,
			check: async () => false,
		});
		expect(await v.verify({ user, strict: true })).toEqual({
			ok: true,
			data: user,
		});
	});

	test('strict without a check throws', async () => {
		const v = createAuth<Payload>({
			source: { key: publicPEM },
			issuer: ISSUER,
		});
		expect(v.strict).toBe(false);
		await expect(v.verify({ user, strict: true })).rejects.toThrow(
			'needs `check`',
		);
	});
});

describe('elysia — auth guards', () => {
	class Unauthorized extends Error {}
	class Invalid extends Error {}
	const errors = {
		unauthorized: () => new Unauthorized(),
		invalid: () => new Invalid(),
	};

	function app(check?: (p: Payload) => Promise<boolean>) {
		const guard = auth(
			createAuth<Payload>({
				source: { key: publicPEM },
				issuer: ISSUER,
				check,
			}),
			errors,
		);
		const onError = ({ error, set, code }: any) => {
			set.status =
				code === 'VALIDATION'
					? 422
					: error instanceof Unauthorized
						? 401
						: error instanceof Invalid
							? 403
							: 500;
			return set.status === 500 ? String(error) : '';
		};
		return {
			guard,
			app: new Elysia()
				.onError(onError)
				.use(
					new Elysia()
						.use(guard.soft)
						.get('/soft', ({ user }) => ({ sub: user?.sub ?? null })),
				)
				.use(
					new Elysia()
						.use(guard.base)
						.get('/base', ({ user }) => ({ sub: user.sub })),
				)
				.use(
					check
						? new Elysia()
								.use(guard.base)
								.use(guard.strict)
								.get('/strict', ({ user }: any) => ({ sub: user.sub }))
						: new Elysia(),
				),
		};
	}

	const call = (
		a: Elysia<any, any, any, any, any, any, any>,
		path: string,
		token?: string,
	) =>
		a.handle(
			new Request(`http://local${path}`, {
				headers: token ? { authorization: `Bearer ${token}` } : {},
			}),
		);

	test('soft: no token or a bad one gives no user, never an error', async () => {
		const { app: a } = app();
		expect(await (await call(a, '/soft')).json()).toEqual({ sub: null });
		expect(await (await call(a, '/soft', 'garbage')).json()).toEqual({
			sub: null,
		});
		expect(await (await call(a, '/soft', await sign(user))).json()).toEqual({
			sub: 'user-1',
		});
	});

	test('base: no token is unauthorized, a bad one invalid, a good one passes', async () => {
		const { app: a } = app();
		expect((await a.handle(new Request('http://local/base'))).status).toBe(422); // header schema
		expect((await call(a, '/base', 'garbage')).status).toBe(403);
		const res = await call(a, '/base', await sign(user));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ sub: 'user-1' });
	});

	test('strict: a blocked token is invalid', async () => {
		const blocked = app(async () => true);
		expect((await call(blocked.app, '/strict', await sign(user))).status).toBe(
			403,
		);
		const open = app(async () => false);
		expect((await call(open.app, '/strict', await sign(user))).status).toBe(
			200,
		);
	});

	test('strict without a check throws at setup', () => {
		const { guard } = app();
		expect(() => guard.strict).toThrow('needs a verifier with `check`');
	});
});
