import { describe, expect, test } from 'bun:test';
import { createRegistry } from '@lib/registry';

describe('createRegistry — http', () => {
	test('returns undefined when no http config is passed', () => {
		const registry = createRegistry({ name: 'test' });
		expect(registry.http().size).toBe(0);
	});

	test('builds a Map keyed by name, one client per entry', () => {
		const registry = createRegistry({
			name: 'test',
			http: [
				{ name: 'notify', baseURL: 'http://notify.local' },
				{ name: 'billing', baseURL: 'http://billing.local' },
			],
		});

		const clients = registry.http();
		expect(clients.size).toBe(2);
		expect(clients.get('notify')).toBeDefined();
		expect(clients.get('billing')).toBeDefined();
		expect(clients.get('unknown')).toBeUndefined();
	});

	test('a client is wired to its own baseURL (name stripped before passing to http())', async () => {
		const calls: string[] = [];
		const fakeFetch = (async (input: string | URL | Request) => {
			calls.push(String(input));
			return new Response(JSON.stringify({ ok: true }), {
				headers: { 'content-type': 'application/json' },
			});
		}) as typeof fetch;

		const registry = createRegistry({
			name: 'test',
			http: [
				{
					name: 'notify',
					baseURL: 'http://notify.local',
					fetch: fakeFetch,
				},
			],
		});

		await registry.http().get('notify')!.get('/health');

		expect(calls).toHaveLength(1);
		expect(calls[0]).toBe('http://notify.local/health');
	});

	test('two named clients are independent — headers/baseURL never bleed across', async () => {
		const seen: Record<string, string> = {};
		const client = (name: string) => ({
			name,
			baseURL: `http://${name}.local`,
			headers: { 'x-service': name },
			fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
				const headers = (init?.headers ?? {}) as Record<string, string>;
				seen[name] = headers['x-service'] ?? '';
				return new Response('ok');
			}) as typeof fetch,
		});

		const registry = createRegistry({
			name: 'test',
			http: [client('notify'), client('billing')],
		});

		await registry.http().get('notify')!.get('/x');
		await registry.http().get('billing')!.get('/x');

		expect(seen.notify).toBe('notify');
		expect(seen.billing).toBe('billing');
	});
});

/** A fetch that answers `status` for every call, counting calls. */
function answer(status: number) {
	const fetch = (async () => {
		fetch.calls++;
		return new Response(null, { status });
	}) as unknown as typeof globalThis.fetch & { calls: number };
	fetch.calls = 0;
	return fetch;
}

const good = () => ({
	connect: async () => {},
	close: async () => {},
	health: async () => ({ ok: true }) as const,
});

describe('createRegistry — http health', () => {
	test('a service shows in details under its name, as a service', async () => {
		const registry = createRegistry({
			name: 'test',
			http: [
				{ name: 'notify', baseURL: 'http://notify.local', fetch: answer(204) },
			],
		});
		const { body } = await registry.health.details();
		expect(body.checks.notify).toMatchObject({
			kind: 'service',
			required: false,
			status: 'pass',
		});
	});

	test('a down service is a warn in details and never fails readiness', async () => {
		const registry = createRegistry({
			name: 'test',
			connections: [{ name: 'postgres', connector: good(), required: true }],
			http: [
				{ name: 'notify', baseURL: 'http://notify.local', fetch: answer(503) },
			],
		});
		await registry.connections().init();

		const details = await registry.health.details();
		expect(details.code).toBe(200);
		expect(details.body.status).toBe('warn');
		expect(details.body.checks.notify?.status).toBe('warn');

		const ready = await registry.health.ready();
		expect(ready.code).toBe(200);
		expect(ready.body).toEqual({ status: 'pass' });
	});

	test('readiness never calls a service', async () => {
		const fetch = answer(204);
		const registry = createRegistry({
			name: 'test',
			http: [{ name: 'notify', baseURL: 'http://notify.local', fetch }],
		});
		await registry.health.ready();
		expect(fetch.calls).toBe(0);
	});

	test('a service check makes `attempts` calls (default 1, no retries)', async () => {
		const once = answer(503);
		await createRegistry({
			name: 'test',
			http: [{ name: 'a', baseURL: 'http://a.local', fetch: once }],
		}).health.details();
		expect(once.calls).toBe(1);

		const thrice = answer(503);
		await createRegistry({
			name: 'test',
			http: [{ name: 'b', baseURL: 'http://b.local', fetch: thrice }],
			health: { attempts: 3, wait: 5_000 },
		}).health.details();
		expect(thrice.calls).toBe(3);
	});

	test('a name shared by a connection and a service throws', () => {
		expect(() =>
			createRegistry({
				name: 'test',
				connections: [{ name: 'notify', connector: good(), required: true }],
				http: [{ name: 'notify', baseURL: 'http://notify.local' }],
			}),
		).toThrow("duplicate name 'notify'");
	});
});
