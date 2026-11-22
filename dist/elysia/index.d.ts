import { auth } from './middlewares/auth.middleware.js';
import { logger } from './middlewares/log.middleware.js';
import { health } from './plugins/health.plugin.js';
export { cors } from '@elysiajs/cors';
export { Elysia } from 'elysia';
export * from './bootstrap.js';
export type { AuthErrors } from './middlewares/auth.middleware.js';
export type { HealthPluginOptions } from './plugins/health.plugin.js';
export declare const middleware: {
    log: typeof logger;
    auth: typeof auth;
};
export declare const plugin: {
    health: typeof health;
};
//# sourceMappingURL=index.d.ts.map