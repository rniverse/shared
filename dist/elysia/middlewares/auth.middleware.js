import { t } from '@rniverse/utils';
import { cxt$req } from '@rniverse/utils/context';
import Elysia from 'elysia';
// Validates the Bearer scheme and strips it — `headers.authorization` in a
// resolve is already the raw token.
const token = t.pipe(t.string(), t.startsWith('Bearer '), t.transform((v) => v.slice(7)));
export const schema$auth = {
    /** Required. */
    bearer: t.object({ authorization: token }),
    /** Optional — absent is fine, but a present value must carry the Bearer scheme. */
    soft: t.object({ authorization: t.optional(token) }),
};
/**
 * `soft`: a token is optional; no token or a bad one gives `user: undefined`,
 * never throws. `base`: a valid token is required. `strict`: `base` plus the
 * verifier's `check` (e.g. a blocklist); it reuses `user` when `base` ran
 * first.
 */
export function auth(verifier, errors) {
    // Put the verified user id on the request context so it rides along on
    // logs and on outbound service calls (x-user-id). Only set here.
    const bind = (user) => {
        cxt$req.set('userId', user.sub);
        return user;
    };
    const fail = (failure) => {
        throw failure === 'missing' ? errors.unauthorized() : errors.invalid();
    };
    const soft = new Elysia({ name: 'auth-guard-soft' })
        .guard({ as: 'scoped', headers: schema$auth.soft })
        .resolve({ as: 'scoped' }, async ({ headers }) => {
        const result = await verifier.verify({ token: headers.authorization });
        return { user: result.ok ? bind(result.data) : undefined };
    });
    const base = new Elysia({ name: 'auth-guard-base' })
        .guard({ as: 'scoped', headers: schema$auth.bearer })
        .resolve({ as: 'scoped' }, async ({ headers }) => {
        const result = await verifier.verify({ token: headers.authorization });
        return { user: result.ok ? bind(result.data) : fail(result.error) };
    });
    // Built only when the verifier can do strict checks; a route that uses
    // `strict` without one is a setup error, caught at startup.
    const strict = verifier.strict
        ? new Elysia({ name: 'auth-guard-strict' })
            .guard({ as: 'scoped', headers: schema$auth.bearer })
            .resolve({ as: 'scoped' }, 
        // ctx.user is set by `base` upstream; its type isn't threaded here
        async (ctx) => {
            const result = await verifier.verify({
                user: ctx.user,
                token: ctx.headers?.authorization,
                strict: true,
            });
            return {
                user: result.ok ? bind(result.data) : fail(result.error),
            };
        })
        : undefined;
    return {
        soft,
        base,
        get strict() {
            if (!strict)
                throw new Error('auth: `strict` needs a verifier with `check`');
            return strict;
        },
    };
}
//# sourceMappingURL=auth.middleware.js.map