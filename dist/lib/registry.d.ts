import { type ClientConfig } from '@rniverse/utils/request';
import type { Result } from '@rniverse/utils/result';
import { type HealthOptions } from './health.js';
export declare const CONNECTION_STATUS: {
    readonly IDLE: 'idle';
    readonly INITIALIZING: 'initializing';
    readonly READY: 'ready';
    readonly CLOSING: 'closing';
    readonly ERROR: 'error';
    readonly CLOSED: 'closed';
};
export type ConnectionStatus = (typeof CONNECTION_STATUS)[keyof typeof CONNECTION_STATUS];
/** Any `@rniverse/connectors` connector (a link) — or anything shaped like one. */
type Connector = {
    connect(): Promise<unknown>;
    /** Never throws for a connectors link. */
    close(): Promise<void>;
    /** Never throws for a connectors link — failures come back as a Result. */
    health(): Promise<Result<unknown>>;
    /** A connectors link's circuit-breaker state. */
    readonly circuit?: string;
    /** A connectors link's events; the registry listens to `fail`. */
    on?(type: 'fail', listener: {
        name: string;
        handler: (event: {
            error: unknown;
        }) => unknown;
    }): void;
};
export type ConnectionConfiguration = {
    name: string;
    connector: Connector;
    required: boolean;
};
/** An HTTP service. Never required — it shows in `health.details()` only. */
export type HttpConfiguration = ClientConfig & {
    name: string;
};
export type RegistryHealthOptions = HealthOptions & {
    /** HTTP services: attempts per check. Default 1 (no retries). */
    attempts?: number;
    /** HTTP services: ms per attempt. Default 5_000. */
    timeout?: number;
};
export declare function createRegistry(config: {
    /** This service's name, shown in `health.details()`. */
    name: string;
    version?: string;
    connections?: ConnectionConfiguration[];
    http?: HttpConfiguration[];
    health?: RegistryHealthOptions;
}): {
    connections: () => {
        init: () => Promise<void>;
        close: () => Promise<void>;
        status: () => ConnectionStatus;
    };
    http: () => Map<string, {
        send: (method: string, path: string, options?: import("@rniverse/utils").RequestConfig) => Promise<Response>;
        health: (options?: import("@rniverse/utils").RequestConfig) => Promise<Result<unknown>>;
        get: <T = unknown>(path: string, options?: import("@rniverse/utils").RequestConfig) => Promise<T>;
        post: <T = unknown>(path: string, options?: import("@rniverse/utils").RequestConfig) => Promise<T>;
        put: <T = unknown>(path: string, options?: import("@rniverse/utils").RequestConfig) => Promise<T>;
        patch: <T = unknown>(path: string, options?: import("@rniverse/utils").RequestConfig) => Promise<T>;
        delete: <T = unknown>(path: string, options?: import("@rniverse/utils").RequestConfig) => Promise<T>;
    }>;
    health: {
        live(): import("./health.js").HealthResponse<{
            status: import("./health.js").Status;
        }>;
        startup(): import("./health.js").HealthResponse<{
            status: import("./health.js").Status;
        }>;
        ready(): Promise<import("./health.js").HealthResponse<{
            status: import("./health.js").Status;
        }>>;
        details(): Promise<import("./health.js").HealthResponse<import("./health.js").Report>>;
    };
};
export {};
//# sourceMappingURL=registry.d.ts.map