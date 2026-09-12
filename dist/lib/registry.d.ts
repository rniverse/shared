import type { RedpandaConnector } from '@rniverse/connectors/redpanda';
import { type ClientConfig } from '@rniverse/utils/request';
import type { Result } from '@rniverse/utils/result';
import type { ConsumerConfig, ConsumerRunConfig, EachMessagePayload, Producer, ProducerConfig } from 'kafkajs';
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
export type HttpServiceConfiguration = ClientConfig & {
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
export declare function createRegistry(config: {
    connections?: ConnectionConfiguration[];
    services?: HttpServiceConfiguration[];
    /** Pass the same connector instance also listed in `connections` — kafka
     * needs the concrete RedpandaConnector (getProducer/getConsumer), not the
     * generic connect/close/health shape `connections` tracks it under. */
    kafka?: {
        connector: RedpandaConnector;
    };
}): {
    connections: {
        init: () => Promise<HealthReport>;
        close: () => Promise<void>;
        health: () => Promise<HealthReport>;
        status: () => ConnectionStatus;
    };
    services: Record<string, {
        send: (method: string, path: string, options?: import("@rniverse/utils").RequestConfig) => Promise<Response>;
        get: <T = unknown>(path: string, options?: import("@rniverse/utils").RequestConfig) => Promise<T>;
        post: <T = unknown>(path: string, options?: import("@rniverse/utils").RequestConfig) => Promise<T>;
        put: <T = unknown>(path: string, options?: import("@rniverse/utils").RequestConfig) => Promise<T>;
        patch: <T = unknown>(path: string, options?: import("@rniverse/utils").RequestConfig) => Promise<T>;
        delete: <T = unknown>(path: string, options?: import("@rniverse/utils").RequestConfig) => Promise<T>;
    }>;
    kafka: {
        register: {
            producer: (name: string, config?: Partial<ProducerConfig>) => Promise<Producer | null>;
            consumer: (config: KafkaConsumerConfig, onMessage: (payload: EachMessagePayload) => Promise<void>, runConfig?: Omit<ConsumerRunConfig, 'eachMessage'>) => Promise<void>;
        };
        registry: {
            producers: Record<string, Producer | null>;
        };
    } | undefined;
};
export {};
//# sourceMappingURL=registry.d.ts.map