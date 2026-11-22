import { cxt$req } from '@rniverse/utils/context';
import { log } from '@rniverse/utils/logger';
import Elysia from 'elysia';
// Path only, no querystring — a route carrying secrets in query params
// (an OAuth callback's code/state, say) must never land in logs.
const pathOf = (url) => {
    try {
        return new URL(url).pathname;
    }
    catch {
        return url;
    }
};
export const logger = () => new Elysia({ name: 'logger' })
    .onRequest(({ request, set }) => {
    cxt$req.set('startedAt', Date.now());
    const requestId = cxt$req.requestId();
    if (requestId)
        set.headers['x-request-id'] = requestId;
    const { method } = request;
    log.info(`Request started - [${method}] ${pathOf(request.url)}`);
})
    .onAfterResponse({ as: 'global' }, ({ request, set }) => {
    const startedAt = cxt$req.get('startedAt');
    const ms = startedAt ? Date.now() - startedAt : undefined;
    const status = typeof set.status === 'number' ? set.status : 200;
    const { method } = request;
    const level = status >= 400 ? 'error' : 'info';
    log[level](`Request completed - [${method}] ${pathOf(request.url)} - [${status}] — ${ms}ms`);
});
//# sourceMappingURL=log.middleware.js.map