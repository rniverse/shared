import Elysia from 'elysia';
import type { Health, HealthResponse } from '../../lib/health';

export type HealthPluginOptions = {
	/** Mount point, e.g. `/api`. Default none. */
	prefix?: string;
	/**
	 * A guard for `/health/details` only, e.g. an auth guard. It is mounted
	 * after the other three routes, so they stay open.
	 */
	guard?: any; // `any` for the same reason as createApp's `api`: Elysia's plugin generics don't cross the package boundary
};

/**
 * `/health/live`, `/health/startup`, `/health/ready` and `/health/details`,
 * served from a registry's `health` (see `lib/health.ts`).
 */
export function health(checks: Health, options: HealthPluginOptions = {}) {
	const send = <B>(
		{ code, body }: HealthResponse<B>,
		set: { status?: unknown },
	) => {
		set.status = code;
		return body;
	};

	const details = new Elysia();
	if (options.guard) details.use(options.guard);
	details.get('/health/details', async ({ set }) =>
		send(await checks.details(), set),
	);

	return new Elysia({ prefix: options.prefix ?? '' })
		.get('/health/live', ({ set }) => send(checks.live(), set))
		.get('/health/startup', ({ set }) => send(checks.startup(), set))
		.get('/health/ready', async ({ set }) => send(await checks.ready(), set))
		.use(details);
}
