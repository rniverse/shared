import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { CONNECTION_STATUS, createRegistry } from '@lib/registry';
import { PostgresConnector } from '@rniverse/connectors/postgres';
import type { Result } from '@rniverse/utils/result';

// A fake `Connector` (connect/close/health) — the exact shape `registry.ts`
// is built around, so a hand-written stub here tests registry.ts's own
// branching (required-vs-optional, state transitions) without depending on
// how any *particular* real connector fails.
function fakeConnector(
	name: string,
	behavior: { failConnect?: boolean; hangConnect?: boolean } = {},
) {
	let connected = false;
	const fake = {
		name,
		checks: 0,
		connect: async () => {
			if (behavior.hangConnect) return new Promise<void>(() => {});
			if (behavior.failConnect) throw new Error(`${name}: connect failed`);
			connected = true;
		},
		close: async () => {
			connected = false;
		},
		health: async (): Promise<Result<void>> => {
			fake.checks++;
			return connected
				? { ok: true }
				: { ok: false, error: new Error('not connected') };
		},
	};
	return fake;
}

describe('createRegistry — connections', () => {
	afterEach(() => {
		(process.exit as any).mockRestore?.();
	});

	test('a required connector that connects successfully reaches READY with a healthy report', async () => {
		const good = fakeConnector('good');
		const registry = createRegistry({
			name: 'test',
			connections: [{ name: 'good', connector: good, required: true }],
		});

		await registry.connections().init();
		const { code, body } = await registry.health.details();

		expect(code).toBe(200);
		expect(body.status).toBe('pass');
		expect(body.checks.good?.status).toBe('pass');
		expect(registry.connections().status()).toBe(CONNECTION_STATUS.READY);
	});

	test('a required connector that fails to connect exits the process', async () => {
		const exit = spyOn(process, 'exit').mockImplementation((() => {}) as any);
		const bad = fakeConnector('bad', { failConnect: true });
		const registry = createRegistry({
			name: 'test',
			connections: [{ name: 'bad', connector: bad, required: true }],
		});

		await registry.connections().init();

		expect(exit).toHaveBeenCalledWith(1);
		// `process.exit(1)` is mocked here so the real process wouldn't actually
		// die — `init()` keeps running past it (in production this never
		// matters, the process is already gone) and unconditionally sets READY
		// at the end, which is why this asserts `exit` rather than the terminal
		// `status()`.
	});

	test('an optional connector that fails to connect does not exit, but reports unhealthy', async () => {
		const exit = spyOn(process, 'exit').mockImplementation((() => {}) as any);
		const required = fakeConnector('primary');
		const optional = fakeConnector('sidecar', { failConnect: true });
		const registry = createRegistry({
			name: 'test',
			connections: [
				{ name: 'primary', connector: required, required: true },
				{ name: 'sidecar', connector: optional, required: false },
			],
		});

		await registry.connections().init();
		await Promise.resolve(); // the background connect's rejection lands
		const { code, body } = await registry.health.details();

		expect(exit).not.toHaveBeenCalled();
		expect(code).toBe(200); // sidecar is optional
		expect(body.status).toBe('warn');
		expect(body.checks.primary?.status).toBe('pass');
		expect(body.checks.sidecar?.status).toBe('warn');
		expect((await registry.health.ready()).code).toBe(200);
		expect(registry.connections().status()).toBe(CONNECTION_STATUS.READY);
	});

	test('an optional connector connects in the background — a hung one never holds up init()', async () => {
		const primary = fakeConnector('primary');
		const hung = fakeConnector('hung', { hangConnect: true });
		const registry = createRegistry({
			name: 'test',
			connections: [
				{ name: 'primary', connector: primary, required: true },
				{ name: 'hung', connector: hung, required: false },
			],
		});

		await registry.connections().init(); // would never resolve if awaited
		expect(registry.connections().status()).toBe(CONNECTION_STATUS.READY);
	});

	test('init() runs one health check, so the cache is filled before the first request', async () => {
		const good = fakeConnector('good');
		const registry = createRegistry({
			name: 'test',
			connections: [{ name: 'good', connector: good, required: true }],
		});

		await registry.connections().init();
		expect(good.checks).toBe(1);
		await registry.health.ready(); // fresh — served from the cache
		expect(good.checks).toBe(1);
	});

	test('a failing check at init() is logged, never fatal', async () => {
		const exit = spyOn(process, 'exit').mockImplementation((() => {}) as any);
		const flaky = fakeConnector('flaky');
		flaky.health = async () => ({ ok: false, error: new Error('down') });
		const registry = createRegistry({
			name: 'test',
			connections: [{ name: 'flaky', connector: flaky, required: true }],
		});

		await registry.connections().init();
		expect(exit).not.toHaveBeenCalled();
		expect(registry.connections().status()).toBe(CONNECTION_STATUS.READY);
	});

	test('a required connector unhealthy after connecting takes working state down', async () => {
		const flaky = fakeConnector('flaky');
		const registry = createRegistry({
			name: 'test',
			connections: [{ name: 'flaky', connector: flaky, required: true }],
			health: { ttl: 0 },
		});
		await registry.connections().init();
		// Force it unhealthy after the fact without touching registry.ts. A
		// zero ttl makes the next read refresh; it serves the stored pass first.
		await flaky.close();
		await registry.health.ready();
		await new Promise((resolve) => setTimeout(resolve, 0)); // the refresh lands

		const { code, body } = await registry.health.ready();

		expect(code).toBe(503);
		expect(body).toEqual({ status: 'fail' });
	});

	test('close() calls every connector.close() and reaches CLOSED', async () => {
		const one = fakeConnector('one');
		const two = fakeConnector('two');
		const registry = createRegistry({
			name: 'test',
			connections: [
				{ name: 'one', connector: one, required: true },
				{ name: 'two', connector: two, required: false },
			],
		});
		await registry.connections().init();

		await registry.connections().close();

		expect(registry.connections().status()).toBe(CONNECTION_STATUS.CLOSED);
		// Readiness fails once shutdown starts.
		expect((await registry.health.ready()).code).toBe(503);
		expect((await one.health()).ok).toBe(false);
		expect((await two.health()).ok).toBe(false);
	});

	test('close() exits the process if a connector fails to close', async () => {
		const exit = spyOn(process, 'exit').mockImplementation((() => {}) as any);
		const broken = fakeConnector('broken');
		broken.close = async () => {
			throw new Error('close failed');
		};
		const registry = createRegistry({
			name: 'test',
			connections: [{ name: 'broken', connector: broken, required: true }],
		});
		await registry.connections().init();

		await registry.connections().close();

		expect(exit).toHaveBeenCalledWith(1);
	});

	test('two createRegistry() calls have fully independent state (multi-DB scenario)', async () => {
		const a = fakeConnector('a');
		const b = fakeConnector('b', { failConnect: true });
		const exit = spyOn(process, 'exit').mockImplementation((() => {}) as any);

		const registryA = createRegistry({
			name: 'test',
			connections: [{ name: 'a', connector: a, required: true }],
		});
		const registryB = createRegistry({
			name: 'test',
			connections: [{ name: 'b', connector: b, required: true }],
		});

		await registryA.connections().init();
		await registryB.connections().init();
		const reportA = (await registryA.health.details()).body;

		// registryA's connector never failed — its READY + healthy report is
		// untouched by registryB's failure, proving there's no shared state
		// between two createRegistry() calls (§3 of spec.md).
		expect(reportA.status).toBe('pass');
		expect(registryA.connections().status()).toBe(CONNECTION_STATUS.READY);
		expect(exit).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(1);
	});
});

describe('createRegistry — connections, against a real Postgres', () => {
	let postgres: PostgresConnector;

	beforeEach(() => {
		postgres = new PostgresConnector({
			name: 'postgres',
			appName: 'shared-test',
			url: process.env.DATABASE_URL!,
		});
	});

	afterEach(async () => {
		await postgres.close();
	});

	test('a real PostgresConnector connects and reports healthy through the registry', async () => {
		const registry = createRegistry({
			name: 'test',
			connections: [{ name: 'postgres', connector: postgres, required: true }],
		});

		await registry.connections().init();
		const { code, body } = await registry.health.details();

		expect(code).toBe(200);
		expect(body.checks.postgres?.status).toBe('pass');
		expect(body.checks.postgres?.circuit).toBe('closed');
	});
});
