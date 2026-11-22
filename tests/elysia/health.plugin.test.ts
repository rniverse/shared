import { describe, expect, test } from 'bun:test';
import { health } from '@elysia/plugins/health.plugin';
import { createRegistry } from '@lib/registry';
import Elysia from 'elysia';

const connector = (ok: boolean) => ({
	connect: async () => {},
	close: async () => {},
	health: async () =>
		ok
			? ({ ok: true } as const)
			: ({ ok: false, error: new Error('down') } as const),
});

async function setup(
	options: { ok?: boolean; guard?: unknown; init?: boolean } = {},
) {
	const registry = createRegistry({
		name: 'svc',
		connections: [
			{ name: 'db', connector: connector(options.ok ?? true), required: true },
		],
	});
	if (options.init ?? true) await registry.connections().init();
	const app = new Elysia().use(
		health(registry.health, { prefix: '/api', guard: options.guard }),
	);
	const get = async (path: string) => {
		const res = await app.handle(new Request(`http://local/api${path}`));
		return { status: res.status, body: await res.json() };
	};
	return { get };
}

describe('elysia — health plugin', () => {
	test('serves the four routes under the prefix', async () => {
		const { get } = await setup();
		expect(await get('/health/live')).toEqual({
			status: 200,
			body: { status: 'pass' },
		});
		expect(await get('/health/startup')).toEqual({
			status: 200,
			body: { status: 'pass' },
		});
		expect(await get('/health/ready')).toEqual({
			status: 200,
			body: { status: 'pass' },
		});
		const details = await get('/health/details');
		expect(details.status).toBe(200);
		expect(details.body).toMatchObject({ status: 'pass', service: 'svc' });
	});

	test('a failed required connection is 503 on ready and details, not on live', async () => {
		const { get } = await setup({ ok: false });
		expect((await get('/health/live')).status).toBe(200);
		expect(await get('/health/ready')).toEqual({
			status: 503,
			body: { status: 'fail' },
		});
		expect((await get('/health/details')).status).toBe(503);
	});

	test('before init(), startup and ready are 503', async () => {
		const { get } = await setup({ init: false });
		expect((await get('/health/startup')).status).toBe(503);
		expect((await get('/health/ready')).status).toBe(503);
	});

	test('the guard covers details only', async () => {
		const guard = new Elysia().onBeforeHandle({ as: 'scoped' }, ({ set }) => {
			set.status = 401;
			return { denied: true };
		});
		const { get } = await setup({ guard });
		expect((await get('/health/live')).status).toBe(200);
		expect((await get('/health/startup')).status).toBe(200);
		expect((await get('/health/ready')).status).toBe(200);
		expect(await get('/health/details')).toEqual({
			status: 401,
			body: { denied: true },
		});
	});
});
