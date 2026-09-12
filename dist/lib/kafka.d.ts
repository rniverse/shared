import type { RedpandaConnector } from '@rniverse/connectors/redpanda';
import type { EachMessagePayload, Producer } from 'kafkajs';
export declare function createKafkaProducer(connector: RedpandaConnector): {
    connect: () => Promise<void>;
    /** null when the producer never connected — caller decides the fallback. */
    get: () => Producer | null;
};
export type KafkaConsumerConfig = {
    groupId: string;
    topic: string;
    fromBeginning?: boolean;
};
export declare function createKafkaConsumer(connector: RedpandaConnector, config: KafkaConsumerConfig): {
    subscribe: (onMessage: (payload: EachMessagePayload) => Promise<void>) => Promise<void>;
};
//# sourceMappingURL=kafka.d.ts.map