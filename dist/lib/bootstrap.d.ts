import Elysia from 'elysia';
type ErrorSpec = {
    code: string;
    message: string;
    status: number;
};
export type CreateAppOptions = {
    api: any;
    /** The repo's own AppError class (from createErrorEnum) — checked via instanceof. */
    AppError: new (...args: any[]) => {
        status_code: number;
        code: string;
        message: string;
    };
    /** Every repo's error list is required to carry these three keys. */
    errors: {
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
export {};
//# sourceMappingURL=bootstrap.d.ts.map