import Elysia from 'elysia';
import type { Health } from '../../lib/health.js';
export type HealthPluginOptions = {
    /** Mount point, e.g. `/api`. Default none. */
    prefix?: string;
    /**
     * A guard for `/health/details` only, e.g. an auth guard. It is mounted
     * after the other three routes, so they stay open.
     */
    guard?: any;
};
/**
 * `/health/live`, `/health/startup`, `/health/ready` and `/health/details`,
 * served from a registry's `health` (see `lib/health.ts`).
 */
export declare function health(checks: Health, options?: HealthPluginOptions): Elysia<string, {
    decorator: {};
    store: {};
    derive: {};
    resolve: {};
}, {
    typebox: {};
    error: {};
}, {
    schema: {};
    standaloneSchema: {};
    macro: {};
    macroFn: {};
    parser: {};
    response: {};
}, {
    [x: string]: {
        health: {
            live: {
                get: {
                    body: unknown;
                    params: {};
                    query: unknown;
                    headers: unknown;
                    response: {
                        200: {
                            status: import("../../index.js").Status;
                        };
                    };
                };
            };
        };
    };
} & {
    [x: string]: {
        health: {
            startup: {
                get: {
                    body: unknown;
                    params: {};
                    query: unknown;
                    headers: unknown;
                    response: {
                        200: {
                            status: import("../../index.js").Status;
                        };
                    };
                };
            };
        };
    };
} & {
    [x: string]: {
        health: {
            ready: {
                get: {
                    body: unknown;
                    params: {};
                    query: unknown;
                    headers: unknown;
                    response: {
                        200: {
                            status: import("../../index.js").Status;
                        };
                    };
                };
            };
        };
    };
} & {
    [x: string]: {};
}, {
    derive: {};
    resolve: {};
    schema: {};
    standaloneSchema: {};
    response: {};
}, {
    derive: {};
    resolve: {};
    schema: {};
    standaloneSchema: {};
    response: {};
} & {
    derive: {};
    resolve: {};
    schema: {};
    standaloneSchema: {};
    response: {};
}>;
//# sourceMappingURL=health.plugin.d.ts.map