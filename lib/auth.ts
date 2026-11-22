import { jose } from '@rniverse/utils';
import { lazy } from '@rniverse/utils/lazy';
import type { Result } from '@rniverse/utils/result';

// Framework-free access-token verification, shared by every service. Only
// verification lives here: signing (and the private key) stays in the issuer
// (aham). Keys are passed in by each service from its own config — this
// module never reads env.
//
// - The issuer passes its PEM public key: `{ key }`.
// - Every other service passes the issuer's JWKS URL: `{ jwks }`. jose fetches
//   the keys on first use, caches them, and refetches when a token carries an
//   unknown `kid`, so a key rotation needs no change in other services.

export type KeySource =
	/** PEM public key (SPKI). */
	| { key: string }
	/** URL of the issuer's JWKS, e.g. `${AUTH_SERVICE_URL}/.well-known/jwks.json`. */
	| { jwks: string };

export type AuthFailure = 'missing' | 'invalid' | 'blocked';

export type AuthOptions<P> = {
	source: KeySource;
	/** Expected `iss`. */
	issuer: string;
	/** Strict verification only: resolve `true` when the token is blocked. */
	check?: (payload: P) => Promise<boolean>;
};

const ALGORITHMS = ['RS256'];

export function createAuth<P extends { sub: string }>(options: AuthOptions<P>) {
	const { source, issuer, check } = options;

	// `algorithms` is pinned so a tampered header can't switch to a weaker alg.
	const rules = { algorithms: ALGORITHMS, issuer };
	const decode: (token: string) => Promise<{ payload: P }> = (() => {
		if ('key' in source) {
			const key = lazy(() => jose.importSPKI(source.key, 'RS256'));
			return async (token) => jose.jwtVerify<P>(token, await key.get(), rules);
		}
		// Fetches lazily on first use and caches; refetches on an unknown `kid`.
		const keys = jose.createRemoteJWKSet(new URL(source.jwks));
		return (token) => jose.jwtVerify<P>(token, keys, rules);
	})();

	return {
		/** Whether strict verification is possible (a `check` was given). */
		strict: Boolean(check),

		/** `'Bearer x'` → `'x'`; anything else → `undefined`. */
		bearer(header?: string | null): string | undefined {
			if (!header?.startsWith('Bearer ')) return undefined;
			return header.slice(7) || undefined;
		},

		/**
		 * Signature, expiry and issuer — and, when `strict`, the `check`. Pass
		 * `user` instead of `token` to run only the strict check on an
		 * already-verified payload.
		 */
		async verify(input: {
			token?: string;
			user?: P;
			strict?: boolean;
		}): Promise<Result<P, AuthFailure>> {
			let payload = input.user;
			if (!payload) {
				if (!input.token) return { ok: false, error: 'missing' };
				try {
					payload = (await decode(input.token)).payload;
				} catch {
					return { ok: false, error: 'invalid' };
				}
			}
			if (input.strict) {
				if (!check) throw new Error('auth: strict verification needs `check`');
				if (await check(payload)) return { ok: false, error: 'blocked' };
			}
			return { ok: true, data: payload };
		},
	};
}

export type Auth<P extends { sub: string } = { sub: string }> = ReturnType<
	typeof createAuth<P>
>;
