import { openapi } from '@elysiajs/openapi';
import { logger } from '../middlewares/log.middleware.js';
import { log } from '@rniverse/utils';
import { cxt$req } from '@rniverse/utils/context';
import { trace$ } from '@rniverse/utils/request';
import { toJsonSchema } from '@valibot/to-json-schema';
import Elysia from 'elysia';
export function createApp(options) {
    const { api, errors } = options;
    const { AppError } = errors;
    const app = new Elysia({ strictPath: true })
        .use(logger())
        .error({ AppError })
        .onError(({ error, code, set }) => {
        if (code !== 'VALIDATION') {
            log.error(error, 'Error occured during request processing');
        }
        else {
            log.error(error.all?.map((e) => e.message), 'Error occured during request processing');
        }
        if (error instanceof AppError) {
            set.status = error.status_code;
            return {
                ok: false,
                error: { code: error.code, message: error.message },
            };
        }
        if (code === 'VALIDATION') {
            set.status = errors.VALIDATION_FAILED.status;
            return {
                ok: false,
                error: {
                    code: errors.VALIDATION_FAILED.code,
                    message: errors.VALIDATION_FAILED.message,
                },
            };
        }
        if (code === 'NOT_FOUND') {
            set.status = errors.NOT_FOUND.status;
            return {
                ok: false,
                error: {
                    code: errors.NOT_FOUND.code,
                    message: errors.NOT_FOUND.message,
                },
            };
        }
        log.error(error, 'Unhandled error');
        set.status = errors.INTERNAL_ERROR.status;
        return {
            ok: false,
            error: {
                code: errors.INTERNAL_ERROR.code,
                message: errors.INTERNAL_ERROR.message,
            },
        };
    })
        .use(openapi({
        mapJsonSchema: {
            // `errorMode: 'ignore'` — transforms have no JSON Schema
            // equivalent; skip them silently in the docs schema instead of
            // logging a warning per request. Runtime validation is unaffected.
            valibot: (schema) => toJsonSchema(schema, { errorMode: 'ignore' }),
        },
    }))
        .use(api);
    // Every request runs inside its own AsyncLocalStorage store (via `run()`,
    // not `enterWith`), no matter whether it arrives through Bun.serve or a
    // direct `app.handle()` call in tests.
    const handle = app.handle.bind(app);
    app.handle = cxt$req.bindFetch(handle, trace$.seed);
    return app;
}
export function listen(app, config) {
    const server = Bun.serve({
        port: config.port,
        hostname: config.host,
        fetch: app.handle, // already context-wrapped by createApp()
    });
    log.info(`Elysia is running at ${server.hostname}:${server.port}`);
    return server;
}
export function registerShutdown(options) {
    const { onShutdown } = options;
    // Both listeners below can legitimately fire more than once for one real
    // shutdown (e.g. a shell wrapping `bun run` can double-forward a signal)
    // — this flag makes the shutdown body run at most once per process,
    // regardless of how many times or from where it's invoked.
    let isShuttingDown = false;
    const shutdown = async (signal) => {
        if (isShuttingDown)
            return;
        isShuttingDown = true;
        log.info(`Received ${signal}, starting clean shutdown...`);
        try {
            await onShutdown(signal);
            log.info('Clean shutdown completed successfully');
            process.exit(0);
        }
        catch (err) {
            log.error(err, 'Error during clean shutdown');
            process.exit(1);
        }
    };
    const unknownErrorListener = async (e) => {
        log.error(e, 'Server shutting down due to a critical error');
        await shutdown('UNKNOWN_ERROR');
    };
    // Cheap insurance against this block itself running twice in one
    // process (e.g. a `bun run <script>` -> shell -> `bun run` chain
    // plausibly double-forwarding one Ctrl-C) — not the fix for duplicate
    // shutdowns, that's the `isShuttingDown` flag above.
    if (process.listenerCount('SIGINT') === 0) {
        process.on('uncaughtException', unknownErrorListener);
        process.on('unhandledRejection', unknownErrorListener);
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
    }
    return { shutdown, unknownErrorListener };
}
//# sourceMappingURL=bootstrap.js.map