import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { CONNECTION_STATUS, createRegistry } from '@lib/registry';
import { SQLConnector } from '@rniverse/connectors/sql';
import type { Result } from '@rniverse/utils/result';

// A fake `Connector` (connect/close/health) — the exact shape `registry.ts`
// is built around, so a hand-written stub here tests registry.ts's own
// branching (required-vs-optional, state transitions) without depending on
// how any *particular* real connector fails.
function fakeConnector(name: string, behavior: { failConnect?: boolean } = {}) {
	let connected = false;
	return {
		name,
		connect: async () => {
			if (behavior.failConnect) throw new Error(`${name}: connect failed`);
			connected = true;
		},
		close: async () => {
			connected = false;
		},
		health: async (): Promise<Result<void>> =>
			connected
				? { ok: true }
				: { ok: false, error: new Error('not connected') },
	};
}

describe('createRegistry — connections', () => {
	afterEach(() => {
		(process.exit as any).mockRestore?.();
	});

	test('a required connector that connects successfully reaches READY with a healthy report', async () => {
		const good = fakeConnector('good');
		const registry = createRegistry({
			connections: [{ name: 'good', connector: good, required: true }],
		});

		const report = await registry.connections().init();

		expect(report.ok).toBe(true);
		expect(report.isInWorkingState).toBe(true);
		expect(report.services.good).toEqual({ ok: true });
		expect(registry.connections().status()).toBe(CONNECTION_STATUS.READY);
	});

	test('a required connector that fails to connect exits the process', async () => {
		const exit = spyOn(process, 'exit').mockImplementation((() => {}) as any);
		const bad = fakeConnector('bad', { failConnect: true });
		const registry = createRegistry({
			connections: [{ name: 'bad', connector: bad, required: true }],
		});

		await registry.connections().init();

		expect(exit).toHaveBeenCalledWith(1);
		// `process.exit(1)` is mocked here so the real process wouldn't actually
		// die — `init()` keeps running past it (in production this never
		// matters, the process is already gone). It finishes its own health
		// check and unconditionally sets READY at the end, which is why this
		// asserts `exit` rather than the terminal `status()`.
	});

	test('an optional connector that fails to connect does not exit, but reports unhealthy', async () => {
		const exit = spyOn(process, 'exit').mockImplementation((() => {}) as any);
		const required = fakeConnector('primary');
		const optional = fakeConnector('sidecar', { failConnect: true });
		const registry = createRegistry({
			connections: [
				{ name: 'primary', connector: required, required: true },
				{ name: 'sidecar', connector: optional, required: false },
			],
		});

		const report = await registry.connections().init();

		expect(exit).not.toHaveBeenCalled();
		expect(report.ok).toBe(false); // sidecar unhealthy
		expect(report.isInWorkingState).toBe(true); // but it's optional
		expect(report.services.primary).toEqual({ ok: true });
		expect(report.services.sidecar.ok).toBe(false);
		expect(registry.connections().status()).toBe(CONNECTION_STATUS.READY);
	});

	test('a required connector unhealthy after connecting takes working state down', async () => {
		const flaky = fakeConnector('flaky');
		const registry = createRegistry({
			connections: [{ name: 'flaky', connector: flaky, required: true }],
		});
		await registry.connections().init();
		// Force it unhealthy after the fact without touching registry.ts.
		await flaky.close();

		const report = await registry.connections().health();

		expect(report.ok).toBe(false);
		expect(report.isInWorkingState).toBe(false);
	});

	test('close() calls every connector.close() and reaches CLOSED', async () => {
		const one = fakeConnector('one');
		const two = fakeConnector('two');
		const registry = createRegistry({
			connections: [
				{ name: 'one', connector: one, required: true },
				{ name: 'two', connector: two, required: false },
			],
		});
		await registry.connections().init();

		await registry.connections().close();

		expect(registry.connections().status()).toBe(CONNECTION_STATUS.CLOSED);
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
			connections: [{ name: 'a', connector: a, required: true }],
		});
		const registryB = createRegistry({
			connections: [{ name: 'b', connector: b, required: true }],
		});

		const reportA = await registryA.connections().init();
		await registryB.connections().init();

		// registryA's connector never failed — its READY + healthy report is
		// untouched by registryB's failure, proving there's no shared state
		// between two createRegistry() calls (§3 of spec.md).
		expect(reportA.ok).toBe(true);
		expect(registryA.connections().status()).toBe(CONNECTION_STATUS.READY);
		expect(exit).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(1);
	});
});

describe('createRegistry — connections, against a real Postgres', () => {
	let postgres: SQLConnector;

	beforeEach(() => {
		postgres = new SQLConnector({ url: process.env.DATABASE_URL! });
	});

	afterEach(async () => {
		await postgres.close();
	});

	test('a real SQLConnector connects and reports healthy through the registry', async () => {
		const registry = createRegistry({
			connections: [{ name: 'postgres', connector: postgres, required: true }],
		});

		const report = await registry.connections().init();

		expect(report.ok).toBe(true);
		expect(report.services.postgres).toEqual({ ok: true });
	});
});
