import { log } from '@rniverse/utils';
import { lazy } from '@rniverse/utils/lazy';
import { timeout } from '@rniverse/utils/resilience';
import type { Result } from '@rniverse/utils/result';

// Framework-free health checks: one cached entry per connection / service,
// four signals (live, startup, ready, details) returned as plain
// `{ code, body }` so any HTTP layer can serve them. See the Elysia plugin in
// `elysia/plugins/health.plugin.ts`.
//
// Each entry is checked on demand and cached for `ttl`. A route always
// answers from the stored result; a stale or failed one is refreshed in the
// background, at most one check per entry at a time. Only an entry that has
// never settled makes a route wait, capped by `wait`.

export type Status = 'pass' | 'warn' | 'fail';

/** What the registry hands over for each connection or HTTP service. */
export type Probe = {
	name: string;
	kind: 'connection' | 'service';
	/** Only a required connection fails readiness. Services are never required. */
	required: boolean;
	check(): Promise<Result<unknown>>;
	/** The connector's circuit-breaker state, when it has one. */
	circuit?(): string | undefined;
	/** Subscribe to the connector's `fail` event, when it has one. */
	watch?(onFail: (error: unknown) => void): void;
};

export type Check = {
	kind: Probe['kind'];
	required: boolean;
	status: Status;
	/** No settled result yet: the first check is still running. */
	pending?: true;
	checkedAt?: string;
	ageSec?: number;
	ms?: number;
	circuit?: string;
	error?: string;
};

export type Report = {
	status: Status;
	service: string;
	version?: string;
	checks: Record<string, Check>;
};

export type HealthResponse<B = unknown> = { code: number; body: B };

/** Where the owning registry is in its life. */
export type Phase = 'starting' | 'ready' | 'closing';

export type HealthOptions = {
	/** ms a settled result stays fresh. Default 30_000. */
	ttl?: number;
	/** ms a route waits for an entry that has never settled. Default 1_000. */
	wait?: number;
};

export const HEALTH_DEFAULTS = { ttl: 30_000, wait: 1_000 } as const;

type Settled = { ok: boolean; error?: unknown; at: number; ms: number };

// `name: message` only — never a stack. The message can still carry a host
// (e.g. `ECONNREFUSED 127.0.0.1:5432`), which is why `details` belongs behind
// a guard or on an internal network.
const describe = (error: unknown): string =>
	error instanceof Error ? `${error.name}: ${error.message}` : String(error);

function createEntry(probe: Probe, ttl: number) {
	let last: Settled | undefined;
	let running = false;

	// One check per entry at a time: `lazy` shares the in-flight load between
	// callers. The load never rejects, so `lazy` keeps its result until the
	// next refresh `reset()`s it — and that only happens when nothing runs, so
	// no older check can ever settle after a newer one started.
	const slot = lazy(async (): Promise<Settled> => {
		running = true;
		const started = Date.now();
		try {
			const result = await probe.check();
			const settled: Settled = result.ok
				? { ok: true, at: Date.now(), ms: Date.now() - started }
				: {
						ok: false,
						error: result.error,
						at: Date.now(),
						ms: Date.now() - started,
					};
			if (!settled.ok) {
				const level = probe.required ? 'error' : 'warn';
				log[level](settled.error, `HEALTH CHECK: ${probe.name} failed:`);
			}
			last = settled;
			return settled;
		} catch (error) {
			// `check()` is meant to return a Result; a throw still counts.
			last = { ok: false, error, at: Date.now(), ms: Date.now() - started };
			return last;
		} finally {
			running = false;
		}
	});

	const refresh = (): Promise<Settled> => {
		if (!running) slot.reset();
		return slot.get();
	};

	// A connector `fail` event marks the entry failed at once. It doesn't touch
	// a running check: that check's result decides, and the next read refreshes.
	probe.watch?.((error) => {
		last = { ok: false, error, at: Date.now(), ms: 0 };
	});

	return {
		probe,
		/** The stored result; starts a background refresh when stale or failed. */
		async read(wait: number): Promise<Settled | undefined> {
			const stale = !last?.ok || Date.now() - last.at >= ttl;
			if (!stale) return last;
			const fresh = refresh();
			// shortcut: the refresh runs as a plain un-awaited promise. On
			// Workers it must go to `ctx.waitUntil()`; add a `defer` hook then.
			if (!last) await timeout(() => fresh, wait).catch(() => undefined);
			return last;
		},
	};
}

type Entry = ReturnType<typeof createEntry>;

function toCheck(entry: Entry, settled: Settled | undefined): Check {
	const { probe } = entry;
	const failed: Status = probe.required ? 'fail' : 'warn';
	const circuit = probe.circuit?.();
	const base: Check = {
		kind: probe.kind,
		required: probe.required,
		status: failed,
		...(circuit ? { circuit } : {}),
	};
	if (!settled) return { ...base, pending: true };
	return {
		...base,
		status: settled.ok ? 'pass' : failed,
		checkedAt: new Date(settled.at).toISOString(),
		ageSec: Math.floor((Date.now() - settled.at) / 1000),
		ms: settled.ms,
		...(settled.ok ? {} : { error: describe(settled.error) }),
	};
}

// 503: a required entry failed, or the registry isn't ready (still starting,
// or shutting down). 504: nothing required failed, but a required entry has
// no result yet. 200 otherwise — `warn` is still serving.
function codeOf(checks: Check[], phase: Phase): number {
	const required = checks.filter((c) => c.required);
	if (phase !== 'ready') return 503;
	if (required.some((c) => c.status === 'fail' && !c.pending)) return 503;
	if (required.some((c) => c.pending)) return 504;
	return 200;
}

function statusOf(checks: Check[], code: number): Status {
	if (code !== 200) return 'fail';
	return checks.some((c) => c.status !== 'pass') ? 'warn' : 'pass';
}

export function createHealth(config: {
	name: string;
	version?: string;
	probes: Probe[];
	phase: () => Phase;
	options?: HealthOptions;
}) {
	const ttl = config.options?.ttl ?? HEALTH_DEFAULTS.ttl;
	const wait = config.options?.wait ?? HEALTH_DEFAULTS.wait;
	const entries = config.probes.map((probe) => createEntry(probe, ttl));

	// All covered entries are read (and refreshed) in parallel.
	const run = async (covered: Entry[]) => {
		const settled = await Promise.all(covered.map((e) => e.read(wait)));
		const checks = Object.fromEntries(
			covered.map((e, i) => [e.probe.name, toCheck(e, settled[i])]),
		);
		const list = Object.values(checks);
		const code = codeOf(list, config.phase());
		return { code, status: statusOf(list, code), checks };
	};

	return {
		/** The process answers. Touches nothing external. */
		live(): HealthResponse<{ status: Status }> {
			return { code: 200, body: { status: 'pass' } };
		},

		/** `init()` has finished. */
		startup(): HealthResponse<{ status: Status }> {
			const started = config.phase() !== 'starting';
			return {
				code: started ? 200 : 503,
				body: { status: started ? 'pass' : 'fail' },
			};
		},

		/** Required connections only. Minimal body. */
		async ready(): Promise<HealthResponse<{ status: Status }>> {
			const covered = entries.filter((e) => e.probe.required);
			const { code, status } = await run(covered);
			return { code, body: { status } };
		},

		/** Every connection and service, with per-entry state. */
		async details(): Promise<HealthResponse<Report>> {
			const { code, status, checks } = await run(entries);
			return {
				code,
				body: {
					status,
					service: config.name,
					...(config.version ? { version: config.version } : {}),
					checks,
				},
			};
		},
	};
}

export type Health = ReturnType<typeof createHealth>;
