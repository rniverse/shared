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
			http: [
				{ name: 'notify', baseURL: 'http://notify.local', fetch: fakeFetch },
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
				seen[name] = headers['x-service'];
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
