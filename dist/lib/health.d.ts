import type { Result } from '@rniverse/utils/result';
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
export type HealthResponse<B = unknown> = {
    code: number;
    body: B;
};
/** Where the owning registry is in its life. */
export type Phase = 'starting' | 'ready' | 'closing';
export type HealthOptions = {
    /** ms a settled result stays fresh. Default 30_000. */
    ttl?: number;
    /** ms a route waits for an entry that has never settled. Default 1_000. */
    wait?: number;
};
export declare const HEALTH_DEFAULTS: {
    readonly ttl: 30000;
    readonly wait: 1000;
};
export declare function createHealth(config: {
    name: string;
    version?: string;
    probes: Probe[];
    phase: () => Phase;
    options?: HealthOptions;
}): {
    /** The process answers. Touches nothing external. */
    live(): HealthResponse<{
        status: Status;
    }>;
    /** `init()` has finished. */
    startup(): HealthResponse<{
        status: Status;
    }>;
    /** Required connections only. Minimal body. */
    ready(): Promise<HealthResponse<{
        status: Status;
    }>>;
    /** Every connection and service, with per-entry state. */
    details(): Promise<HealthResponse<Report>>;
};
export type Health = ReturnType<typeof createHealth>;
//# sourceMappingURL=health.d.ts.map