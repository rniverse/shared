import { type ClientConfig } from '@rniverse/utils/request';
import type { Result } from '@rniverse/utils/result';
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
};
export type ConnectionConfiguration = {
    name: string;
    connector: Connector;
    required: boolean;
};
export type HttpConfiguration = ClientConfig & {
    name: string;
};
export type HealthReport = {
    ok: boolean;
    isInWorkingState: boolean;
    services: Record<string, {
        ok: boolean;
        error?: unknown;
    }>;
};
export declare function createRegistry(config: {
    connections?: ConnectionConfiguration[];
    http?: HttpConfiguration[];
}): {
    connections: () => {
        init: () => Promise<void>;
        close: () => Promise<void>;
        health: () => Promise<HealthReport>;
        status: () => ConnectionStatus;
    };
    http: () => Map<string, {
        send: (method: string, path: string, options?: import("@rniverse/utils").RequestConfig) => Promise<Response>;
        get: <T = unknown>(path: string, options?: import("@rniverse/utils").RequestConfig) => Promise<T>;
        post: <T = unknown>(path: string, options?: import("@rniverse/utils").RequestConfig) => Promise<T>;
        put: <T = unknown>(path: string, options?: import("@rniverse/utils").RequestConfig) => Promise<T>;
        patch: <T = unknown>(path: string, options?: import("@rniverse/utils").RequestConfig) => Promise<T>;
        delete: <T = unknown>(path: string, options?: import("@rniverse/utils").RequestConfig) => Promise<T>;
    }>;
};
export {};
//# sourceMappingURL=registry.d.ts.map