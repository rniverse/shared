import { jose } from '@rniverse/utils';
import { lazy } from '@rniverse/utils/lazy';
const ALGORITHMS = ['RS256'];
export function createAuth(options) {
    const { source, issuer, check } = options;
    // `algorithms` is pinned so a tampered header can't switch to a weaker alg.
    const rules = { algorithms: ALGORITHMS, issuer };
    const decode = (() => {
        if ('key' in source) {
            const key = lazy(() => jose.importSPKI(source.key, 'RS256'));
            return async (token) => jose.jwtVerify(token, await key.get(), rules);
        }
        // Fetches lazily on first use and caches; refetches on an unknown `kid`.
        const keys = jose.createRemoteJWKSet(new URL(source.jwks));
        return (token) => jose.jwtVerify(token, keys, rules);
    })();
    return {
        /** Whether strict verification is possible (a `check` was given). */
        strict: Boolean(check),
        /** `'Bearer x'` → `'x'`; anything else → `undefined`. */
        bearer(header) {
            if (!header?.startsWith('Bearer '))
                return undefined;
            return header.slice(7) || undefined;
        },
        /**
         * Signature, expiry and issuer — and, when `strict`, the `check`. Pass
         * `user` instead of `token` to run only the strict check on an
         * already-verified payload.
         */
        async verify(input) {
            let payload = input.user;
            if (!payload) {
                if (!input.token)
                    return { ok: false, error: 'missing' };
                try {
                    payload = (await decode(input.token)).payload;
                }
                catch {
                    return { ok: false, error: 'invalid' };
                }
            }
            if (input.strict) {
                if (!check)
                    throw new Error('auth: strict verification needs `check`');
                if (await check(payload))
                    return { ok: false, error: 'blocked' };
            }
            return { ok: true, data: payload };
        },
    };
}
//# sourceMappingURL=auth.js.map