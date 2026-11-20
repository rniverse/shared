import { describe, expect, test } from 'bun:test';
import { createRegistry } from '@lib/registry';

describe('createRegistry — http', () => {
	test('returns undefined when no http config is passed', () => {
		const registry = createRegistry({});
		expect(registry.http().size).toBe(0);
	});

	test('builds a Map keyed by name, one client per entry', () => {
		const registry = createRegistry({
			http: [
				{ name: 'notify', baseURL: 'http://notify.local', required: true },
				{ name: 'billing', baseURL: 'http://billing.local', required: false },
			],
		});

		const clients = registry.http();
		expect(clients.size).toBe(2);
		expect(clients.get('notify')).toBeDefined();
		expect(clients.get('billing')).toBeDefined();
		expect(clients.get('unknown')).toBeUndefined();
	});

	test('a client is wired to its own baseURL (name/required stripped before passing to http())', async () => {
		const calls: string[] = [];
		const fakeFetch = (async (input: string | URL | Request) => {
			calls.push(String(input));
			return new Response(JSON.stringify({ ok: true }), {
				headers: { 'content-type': 'application/json' },
			});
		}) as typeof fetch;

		const registry = createRegistry({
			http: [
				{
					name: 'notify',
					baseURL: 'http://notify.local',
					required: true,
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
			required: false,
			baseURL: `http://${name}.local`,
			headers: { 'x-service': name },
			fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
				const headers = (init?.headers ?? {}) as Record<string, string>;
				seen[name] = headers['x-service'] ?? '';
				return new Response('ok');
			}) as typeof fetch,
		});

		const registry = createRegistry({
			http: [client('notify'), client('billing')],
		});

		await registry.http().get('notify')!.get('/x');
		await registry.http().get('billing')!.get('/x');

		expect(seen.notify).toBe('notify');
		expect(seen.billing).toBe('billing');
	});
});

/** A fetch that answers `status` for every call. */
const answer = (status: number) =>
	(async () => new Response(null, { status })) as unknown as typeof fetch;

describe('createRegistry — http health', () => {
	test('each service joins the health report under its name', async () => {
		const registry = createRegistry({
			http: [
				{
					name: 'notify',
					baseURL: 'http://notify.local',
					required: true,
					fetch: answer(204),
				},
			],
		});
		const report = await registry.connections().health();
		expect(report.ok).toBe(true);
		expect(report.isInWorkingState).toBe(true);
		expect(report.services.notify?.ok).toBe(true);
	});

	test('an unhealthy required service takes working state down', async () => {
		const registry = createRegistry({
			http: [
				{
					name: 'notify',
					baseURL: 'http://notify.local',
					required: true,
					retries: 0,
					fetch: answer(503),
				},
			],
		});
		const report = await registry.connections().health();
		expect(report.ok).toBe(false);
		expect(report.isInWorkingState).toBe(false);
	});

	test('an unhealthy optional service leaves working state up', async () => {
		const registry = createRegistry({
			http: [
				{
					name: 'billing',
					baseURL: 'http://billing.local',
					required: false,
					retries: 0,
					fetch: answer(503),
				},
			],
		});
		const report = await registry.connections().health();
		expect(report.ok).toBe(false);
		expect(report.isInWorkingState).toBe(true);
		expect(report.services.billing?.ok).toBe(false);
	});

	test('init() never calls an HTTP service', async () => {
		let calls = 0;
		const registry = createRegistry({
			http: [
				{
					name: 'notify',
					baseURL: 'http://notify.local',
					required: true,
					fetch: (async () => {
						calls++;
						return new Response(null, { status: 503 });
					}) as unknown as typeof fetch,
				},
			],
		});
		await registry.connections().init();
		expect(calls).toBe(0);
	});

	test('a name shared by a connection and a service throws', () => {
		const connector = {
			connect: async () => {},
			close: async () => {},
			health: async () => ({ ok: true }) as const,
		};
		expect(() =>
			createRegistry({
				connections: [{ name: 'notify', connector, required: true }],
				http: [
					{ name: 'notify', baseURL: 'http://notify.local', required: true },
				],
			}),
		).toThrow("duplicate name 'notify'");
	});
});
