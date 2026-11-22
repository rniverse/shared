import { auth } from './middlewares/auth.middleware';
import { logger } from './middlewares/log.middleware';
import { health } from './plugins/health.plugin';

// The one Elysia every service uses. Services import Elysia (and its plugins)
// from here and don't depend on `elysia` themselves, so the version is set in
// shared's package.json only.
export { cors } from '@elysiajs/cors';
export { Elysia } from 'elysia';

export * from './bootstrap';
export type { AuthErrors } from './middlewares/auth.middleware';
export type { HealthPluginOptions } from './plugins/health.plugin';

export const middleware = { log: logger, auth };
export const plugin = { health };
