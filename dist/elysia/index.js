import { auth } from './middlewares/auth.middleware.js';
import { logger } from './middlewares/log.middleware.js';
import { health } from './plugins/health.plugin.js';
// The one Elysia every service uses. Services import Elysia (and its plugins)
// from here and don't depend on `elysia` themselves, so the version is set in
// shared's package.json only.
export { cors } from '@elysiajs/cors';
export { Elysia } from 'elysia';
export * from './bootstrap.js';
export const middleware = { log: logger, auth };
export const plugin = { health };
//# sourceMappingURL=index.js.map