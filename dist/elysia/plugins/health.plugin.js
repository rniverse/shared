import Elysia from 'elysia';
/**
 * `/health/live`, `/health/startup`, `/health/ready` and `/health/details`,
 * served from a registry's `health` (see `lib/health.ts`).
 */
export function health(checks, options = {}) {
    const send = ({ code, body }, set) => {
        set.status = code;
        return body;
    };
    const details = new Elysia();
    if (options.guard)
        details.use(options.guard);
    details.get('/health/details', async ({ set }) => send(await checks.details(), set));
    return new Elysia({ prefix: options.prefix ?? '' })
        .get('/health/live', ({ set }) => send(checks.live(), set))
        .get('/health/startup', ({ set }) => send(checks.startup(), set))
        .get('/health/ready', async ({ set }) => send(await checks.ready(), set))
        .use(details);
}
//# sourceMappingURL=health.plugin.js.map