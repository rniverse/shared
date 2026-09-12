import type { RedpandaConnector } from '@rniverse/connectors/redpanda';
import { type ClientConfig } from '@rniverse/utils/request';
import type { Result } from '@rniverse/utils/result';
import type { Consumer, ConsumerConfig, Producer, ProducerConfig } from 'kafkajs';
export declare const CONNECTION_STATUS: {
    readonly IDLE: 'idle';
    readonly INITIALIZING: 'initializing';
    readonly READY: 'ready';
    readonly CLOSING: 'closing';
    readonly ERROR: 'error';
    readonly CLOSED: 'closed';
};
export type ConnectionStatus = (typeof CONNECTION_STATUS)[keyof typeof CONNECTION_STATUS];
type Connector = {
    connect(): Promise<unknown>;
    close(): Promise<void>;
    health(): Promise<Result<void>>;
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
export type KafkaConsumerConfig = ConsumerConfig & {
    topic: string;
    fromBeginning?: boolean;
};
/**
 * `name` is the actual registry key (what `producers.get()`/`.run()` look
 * up) — deliberately not the object key the caller declares this under.
 * Decouples the stable, typo-checked TS property (`config.kafka.producers.
 * notifier`) from the runtime label (env-driven, shows up in log lines,
 * can differ per deployment without a code change).
 */
export type KafkaProducerConfiguration = Partial<ProducerConfig> & {
    name: string;
};
export type KafkaConsumerConfiguration = KafkaConsumerConfig & {
    name: string;
};
export declare function createRegistry(config: {
    connections?: ConnectionConfiguration[];
    http?: HttpConfiguration[];
    /** Pass the same connector instance also listed in `connections` — kafka
     * needs the concrete RedpandaConnector (getProducer/getConsumer), not the
     * generic connect/close/health shape `connections` tracks it under. */
    kafka?: {
        connector: RedpandaConnector;
        producers?: Record<string, KafkaProducerConfiguration>;
        consumers?: Record<string, KafkaConsumerConfiguration>;
    };
}): {
    connections: () => {
        init: () => Promise<HealthReport>;
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
    kafka: () => {
        connect: () => Promise<void>;
        producers: Map<string, Producer | null>;
        consumers: Map<string, Consumer>;
    } | undefined;
};
export {};
//# sourceMappingURL=registry.d.ts.map