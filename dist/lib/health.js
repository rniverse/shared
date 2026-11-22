import { log } from '@rniverse/utils';
import { lazy } from '@rniverse/utils/lazy';
import { timeout } from '@rniverse/utils/resilience';
export const HEALTH_DEFAULTS = { ttl: 30_000, wait: 1_000 };
// `name: message` only — never a stack. The message can still carry a host
// (e.g. `ECONNREFUSED 127.0.0.1:5432`), which is why `details` belongs behind
// a guard or on an internal network.
const describe = (error) => error instanceof Error ? `${error.name}: ${error.message}` : String(error);
function createEntry(probe, ttl) {
    let last;
    let running = false;
    // One check per entry at a time: `lazy` shares the in-flight load between
    // callers. The load never rejects, so `lazy` keeps its result until the
    // next refresh `reset()`s it — and that only happens when nothing runs, so
    // no older check can ever settle after a newer one started.
    const slot = lazy(async () => {
        running = true;
        const started = Date.now();
        try {
            const result = await probe.check();
            const settled = result.ok
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
        }
        catch (error) {
            // `check()` is meant to return a Result; a throw still counts.
            last = { ok: false, error, at: Date.now(), ms: Date.now() - started };
            return last;
        }
        finally {
            running = false;
        }
    });
    const refresh = () => {
        if (!running)
            slot.reset();
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
        async read(wait) {
            const stale = !last?.ok || Date.now() - last.at >= ttl;
            if (!stale)
                return last;
            const fresh = refresh();
            // shortcut: the refresh runs as a plain un-awaited promise. On
            // Workers it must go to `ctx.waitUntil()`; add a `defer` hook then.
            if (!last)
                await timeout(() => fresh, wait).catch(() => undefined);
            return last;
        },
    };
}
function toCheck(entry, settled) {
    const { probe } = entry;
    const failed = probe.required ? 'fail' : 'warn';
    const circuit = probe.circuit?.();
    const base = {
        kind: probe.kind,
        required: probe.required,
        status: failed,
        ...(circuit ? { circuit } : {}),
    };
    if (!settled)
        return { ...base, pending: true };
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
function codeOf(checks, phase) {
    const required = checks.filter((c) => c.required);
    if (phase !== 'ready')
        return 503;
    if (required.some((c) => c.status === 'fail' && !c.pending))
        return 503;
    if (required.some((c) => c.pending))
        return 504;
    return 200;
}
function statusOf(checks, code) {
    if (code !== 200)
        return 'fail';
    return checks.some((c) => c.status !== 'pass') ? 'warn' : 'pass';
}
export function createHealth(config) {
    const ttl = config.options?.ttl ?? HEALTH_DEFAULTS.ttl;
    const wait = config.options?.wait ?? HEALTH_DEFAULTS.wait;
    const entries = config.probes.map((probe) => createEntry(probe, ttl));
    // All covered entries are read (and refreshed) in parallel.
    const run = async (covered) => {
        const settled = await Promise.all(covered.map((e) => e.read(wait)));
        const checks = Object.fromEntries(covered.map((e, i) => [e.probe.name, toCheck(e, settled[i])]));
        const list = Object.values(checks);
        const code = codeOf(list, config.phase());
        return { code, status: statusOf(list, code), checks };
    };
    return {
        /** The process answers. Touches nothing external. */
        live() {
            return { code: 200, body: { status: 'pass' } };
        },
        /** `init()` has finished. */
        startup() {
            const started = config.phase() !== 'starting';
            return {
                code: started ? 200 : 503,
                body: { status: started ? 'pass' : 'fail' },
            };
        },
        /** Required connections only. Minimal body. */
        async ready() {
            const covered = entries.filter((e) => e.probe.required);
            const { code, status } = await run(covered);
            return { code, body: { status } };
        },
        /** Every connection and service, with per-entry state. */
        async details() {
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
//# sourceMappingURL=health.js.map