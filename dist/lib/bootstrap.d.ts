import Elysia from 'elysia';
import type { ErrorSpec } from './error.js';
export type CreateAppOptions = {
    api: any;
    /**
     * One bundle, not two — `AppError` lives alongside the three required
     * specs because both come from the same `createErrorEnum()` call and
     * are always passed together. See errors.enum.ts's `BOOTSTRAP_ERRORS`.
     */
    errors: {
        /** The repo's own AppError class (from createErrorEnum) — checked via instanceof. */
        AppError: new (...args: any[]) => {
            status_code: number;
            code: string;
            message: string;
        };
        NOT_FOUND: ErrorSpec;
        VALIDATION_FAILED: ErrorSpec;
        INTERNAL_ERROR: ErrorSpec;
    };
};
export declare function createApp(options: CreateAppOptions): Elysia<"", {
    decorator: any;
    store: {
        [x: string]: any;
    };
    derive: any;
    resolve: any;
}, any, any, any, {
    derive: {};
    resolve: {};
    schema: {};
    standaloneSchema: {};
    response: {};
}, any>;
export declare function listen(app: {
    handle: unknown;
}, config: {
    port: number;
    host: string;
}): Bun.Server<undefined>;
export type RegisterShutdownOptions = {
    /** Called once per real shutdown — close connections, flush, etc. */
    onShutdown: (signal: string) => Promise<void>;
};
export declare function registerShutdown(options: RegisterShutdownOptions): {
    shutdown: (signal: string) => Promise<void>;
    unknownErrorListener: (e: Error) => Promise<void>;
};
//# sourceMappingURL=bootstrap.d.ts.map