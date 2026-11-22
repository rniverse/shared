import { describe, expect, test } from 'bun:test';
import { createHealth, type Phase, type Probe } from '@lib/health';
import type { Result } from '@rniverse/utils/result';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** A probe whose next result is set by hand; `hold` keeps a check running until released. */
function probe(
	name: string,
	options: Partial<Pick<Probe, 'required' | 'kind'>> = {},
) {
	let next: Result<unknown> = { ok: true };
	let gate: Promise<void> | null = null;
	let open = () => {};
	let fail: ((error: unknown) => void) | undefined;
	const p = {
		name,
		kind: options.kind ?? 'connection',
		required: options.required ?? true,
		calls: 0,
		async check() {
			p.calls++;
			if (gate) await gate;
			return next;
		},
		watch(onFail: (error: unknown) => void) {
			fail = onFail;
		},
		set(result: Result<unknown>) {
			next = result;
		},
		hold() {
			gate = new Promise<void>((resolve) => {
				open = resolve;
			});
		},
		release() {
			gate = null;
			open();
		},
		fail(error: unknown) {
			fail?.(error);
		},
	} satisfies Probe & Record<string, unknown>;
	return p;
}

function setup(
	probes: Probe[],
	options: { ttl?: number; wait?: number; phase?: Phase } = {},
) {
	let phase: Phase = options.phase ?? 'ready';
	const health = createHealth({
		name: 'svc',
		version: '1.2.3',
		probes,
		phase: () => phase,
		options: { ttl: options.ttl ?? 60_000, wait: options.wait ?? 50 },
	});
	return {
		health,
		setPhase: (next: Phase) => {
			phase = next;
		},
	};
}

describe('health — signals', () => {
	test('live is always 200 and never runs a check', () => {
		const db = probe('db');
		const { health } = setup([db], { phase: 'closing' });
		expect(health.live()).toEqual({ code: 200, body: { status: 'pass' } });
		expect(db.calls).toBe(0);
	});

	test('startup is 503 while starting, 200 after', () => {
		const { health, setPhase } = setup([], { phase: 'starting' });
		expect(health.startup()).toEqual({ code: 503, body: { status: 'fail' } });
		setPhase('ready');
		expect(health.startup()).toEqual({ code: 200, body: { status: 'pass' } });
	});

	test('ready covers required entries only, with a minimal body', async () => {
		const db = probe('db');
		const cache = probe('cache', { required: false });
		const { health } = setup([db, cache]);
		cache.set({ ok: false, error: new Error('down') });

		expect(await health.ready()).toEqual({
			code: 200,
			body: { status: 'pass' },
		});
		expect(cache.calls).toBe(0);
	});

	test('ready is 503 when a required entry failed', async () => {
		const db = probe('db');
		db.set({ ok: false, error: new Error('down') });
		const { health } = setup([db]);
		expect(await health.ready()).toEqual({
			code: 503,
			body: { status: 'fail' },
		});
	});

	test('ready is 503 while starting or closing, even when every check passes', async () => {
		const { health, setPhase } = setup([probe('db')], { phase: 'starting' });
		expect((await health.ready()).code).toBe(503);
		setPhase('closing');
		expect((await health.ready()).code).toBe(503);
	});

	test('details covers everything; an optional failure is warn with 200', async () => {
		const db = probe('db');
		const notify = probe('notify', { kind: 'service', required: false });
		notify.set({ ok: false, error: new TypeError('fetch failed') });
		const { health } = setup([db, notify]);

		const { code, body } = await health.details();
		expect(code).toBe(200);
		expect(body).toMatchObject({
			status: 'warn',
			service: 'svc',
			version: '1.2.3',
		});
		expect(body.checks.db).toMatchObject({
			kind: 'connection',
			required: true,
			status: 'pass',
		});
		expect(body.checks.notify).toMatchObject({
			kind: 'service',
			required: false,
			status: 'warn',
			error: 'TypeError: fetch failed',
		});
		expect(body.checks.db?.checkedAt).toBeString();
	});

	test('errors are reduced to name: message, never a stack', async () => {
		const db = probe('db');
		db.set({ ok: false, error: new Error('boom') });
		const { health } = setup([db]);
		const { body } = await health.details();
		expect(body.checks.db?.error).toBe('Error: boom');
	});
});

describe('health — cache', () => {
	test('a fresh result is reused', async () => {
		const db = probe('db');
		const { health } = setup([db]);
		await health.ready();
		await health.ready();
		expect(db.calls).toBe(1);
	});

	test('a stale result is served at once and refreshed once in the background', async () => {
		const db = probe('db');
		const { health } = setup([db], { ttl: 0 });
		await health.ready(); // first check
		db.set({ ok: false, error: new Error('down') });
		db.hold();

		// Stale: served as stored (pass) while one refresh runs.
		expect((await health.ready()).code).toBe(200);
		expect((await health.ready()).code).toBe(200);
		expect(db.calls).toBe(2);

		db.release();
		await tick();
		expect((await health.ready()).code).toBe(503);
	});

	test('a failed result is served and refreshed on the next read', async () => {
		const db = probe('db');
		db.set({ ok: false, error: new Error('down') });
		const { health } = setup([db]);
		expect((await health.ready()).code).toBe(503);

		db.set({ ok: true });
		expect((await health.ready()).code).toBe(503); // still the stored failure
		await tick();
		expect((await health.ready()).code).toBe(200);
	});

	test('single flight: concurrent reads run one check', async () => {
		const db = probe('db');
		db.hold();
		const { health } = setup([db], { wait: 1_000 });
		const reads = [health.ready(), health.ready(), health.details()];
		await tick();
		db.release();
		await Promise.all(reads);
		expect(db.calls).toBe(1);
	});

	test('no result yet: waits up to `wait`, then a required entry gives 504', async () => {
		const db = probe('db');
		db.hold();
		const { health } = setup([db], { wait: 20 });

		const started = Date.now();
		const { code, body } = await health.details();
		expect(Date.now() - started).toBeLessThan(500);
		expect(code).toBe(504);
		expect(body.status).toBe('fail');
		expect(body.checks.db).toMatchObject({ status: 'fail', pending: true });

		// The check keeps running and its result is stored when it settles.
		db.release();
		await tick();
		expect((await health.details()).code).toBe(200);
		expect(db.calls).toBe(1);
	});

	test('a pending optional entry never changes the code', async () => {
		const kafka = probe('kafka', { required: false });
		kafka.hold();
		const { health } = setup([probe('db'), kafka], { wait: 10 });
		const { code, body } = await health.details();
		expect(code).toBe(200);
		expect(body.checks.kafka).toMatchObject({ status: 'warn', pending: true });
		kafka.release();
	});

	test('504 loses to 503: a failed required entry wins over a pending one', async () => {
		const db = probe('db');
		db.set({ ok: false, error: new Error('down') });
		const slow = probe('slow');
		slow.hold();
		const { health } = setup([db, slow], { wait: 10 });
		expect((await health.ready()).code).toBe(503);
		slow.release();
	});

	test('entries are checked in parallel', async () => {
		const slow = (name: string) => {
			const p = probe(name);
			const check = p.check;
			p.check = async () => {
				await tick(60);
				return check();
			};
			return p;
		};
		const { health } = setup([slow('a'), slow('b'), slow('c')], {
			wait: 1_000,
		});
		const started = Date.now();
		await health.ready();
		expect(Date.now() - started).toBeLessThan(150);
	});

	test('a check that throws counts as failed', async () => {
		const db = probe('db');
		db.check = async () => {
			throw new Error('threw');
		};
		const { health } = setup([db]);
		const { code, body } = await health.details();
		expect(code).toBe(503);
		expect(body.checks.db?.error).toBe('Error: threw');
	});
});

describe('health — fail event', () => {
	test('marks a cached pass as failed at once, then the next read re-checks', async () => {
		const db = probe('db');
		const { health } = setup([db]);
		expect((await health.ready()).code).toBe(200);

		db.fail(new Error('connection lost'));
		const { code, body } = await health.details();
		expect(code).toBe(503);
		expect(body.checks.db?.error).toBe('Error: connection lost');

		await tick(); // the re-check (still passing) lands
		expect((await health.ready()).code).toBe(200);
		expect(db.calls).toBe(2);
	});

	test('during a running check it starts no second check; that check decides', async () => {
		const db = probe('db');
		const { health } = setup([db], { ttl: 0 });
		await health.ready();
		db.hold();
		await health.ready(); // stale: starts a refresh, which is held
		expect(db.calls).toBe(2);

		db.fail(new Error('connection lost'));
		expect((await health.ready()).code).toBe(503);
		expect(db.calls).toBe(2); // joined the running check

		db.release(); // it passes
		await tick();
		const { body } = await health.details();
		expect(body.checks.db?.status).toBe('pass');
	});
});
