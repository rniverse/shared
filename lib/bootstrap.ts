import { openapi } from '@elysiajs/openapi';
import { logger } from '@middlewares/log.middleware';
import { log, runWithContext } from '@rniverse/utils';
import { cxt$req } from '@rniverse/utils/context';
import { trace$ } from '@rniverse/utils/request';
import { toJsonSchema } from '@valibot/to-json-schema';
import Elysia from 'elysia';
import type { ErrorSpec } from './error';

// Generalizes the Elysia app shell every service was hand-rolling
// identically: onError envelope, openapi docs, and the per-request
// AsyncLocalStorage wrap. Deliberately split into three pieces
// (createApp / listen / registerShutdown) rather than one `init()` —
// a caller that needs an extra step before listening (e.g. notify's
// Kafka consumer subscribe) just sequences it between the two calls,
// no special hook needed here.

export type CreateAppOptions = {
	// `any` on purpose — each repo's `createAPI()` returns an Elysia instance
	// typed with its own route/schema generics; forcing that through a bare
	// `Elysia` parameter here trips Elysia's invariant plugin-composition
	// types at the function boundary. The app is used structurally below
	// (.error/.onError/.use), never for route-level type inference.
	api: any;
	/**
	 * One bundle, not two — `AppError` lives alongside the three required
	 * specs because both come from the same `createErrorEnum()` call and
	 * are always passed together. See errors.enum.ts's `BOOTSTRAP_ERRORS`.
	 */
	errors: {
		/** The repo's own AppError class (from createErrorEnum) — checked via instanceof. */
		AppError: new (
			...args: any[]
		) => { status_code: number; code: string; message: string };
		NOT_FOUND: ErrorSpec;
		VALIDATION_FAILED: ErrorSpec;
		INTERNAL_ERROR: ErrorSpec;
	};
};

export function createApp(options: CreateAppOptions) {
	const { api, errors } = options;
	const { AppError } = errors;

	const app = new Elysia({ strictPath: true })
		.use(logger())
		.error({ AppError })
		.onError(({ error, code, set }) => {
			if (code !== 'VALIDATION') {
				log.error(error, 'Error occured during request processing');
			} else {
				log.error(
					(error as any).all?.map((e: any) => e.message),
					'Error occured during request processing',
				);
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
		.use(
			openapi({
				mapJsonSchema: {
					// `errorMode: 'ignore'` — transforms have no JSON Schema
					// equivalent; skip them silently in the docs schema instead of
					// logging a warning per request. Runtime validation is unaffected.
					valibot: (schema: Parameters<typeof toJsonSchema>[0]) =>
						toJsonSchema(schema, { errorMode: 'ignore' }),
				},
			}),
		)
		.use(api);

	// Every request runs inside its own AsyncLocalStorage store (via `run()`,
	// not `enterWith`), no matter whether it arrives through Bun.serve or a
	// direct `app.handle()` call in tests.
	const handle = app.handle.bind(app);
	app.handle = cxt$req.bindFetch(handle, trace$.seed) as typeof app.handle;

	return app;
}

export function listen(
	app: { handle: unknown },
	config: { port: number; host: string },
) {
	const server = Bun.serve({
		port: config.port,
		hostname: config.host,
		fetch: app.handle as any, // already context-wrapped by createApp()
	});
	log.info(`Elysia is running at ${server.hostname}:${server.port}`);
	return server;
}

export type RegisterShutdownOptions = {
	/** Called once per real shutdown — close connections, flush, etc. */
	onShutdown: (signal: string) => Promise<void>;
};

export function registerShutdown(options: RegisterShutdownOptions) {
	const { onShutdown } = options;

	// Both listeners below can legitimately fire more than once for one real
	// shutdown (e.g. a shell wrapping `bun run` can double-forward a signal)
	// — this flag makes the shutdown body run at most once per process,
	// regardless of how many times or from where it's invoked.
	let isShuttingDown = false;

	const shutdown = async (signal: string) => {
		if (isShuttingDown) return;
		isShuttingDown = true;
		log.info(`Received ${signal}, starting clean shutdown...`);
		try {
			await onShutdown(signal);
			log.info('Clean shutdown completed successfully');
			process.exit(0);
		} catch (err) {
			log.error(err, 'Error during clean shutdown');
			process.exit(1);
		}
	};

	const unknownErrorListener = async (e: Error) => {
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

/**
 * The `if (import.meta.main) { ... }` body every repo had byte-identical —
 * wire the shutdown listeners, then run `init().then(listen)` inside its own
 * request context so early startup logs still carry a requestId. The
 * `import.meta.main` guard itself has to stay in the caller: `import.meta`
 * is per-module, checking it in here would only ever reflect this shared
 * module, never the repo that called it.
 */
export function boot<App extends { handle: unknown }>(
	init: () => Promise<App>,
	serverConfig: { port: number; host: string },
	onShutdown: (signal: string) => Promise<void>,
): void {
	const { unknownErrorListener } = registerShutdown({ onShutdown });
	runWithContext(async () => init().then((app) => listen(app, serverConfig)), {
		requestId: 'SERVER_LOG',
	}).catch(unknownErrorListener);
}
