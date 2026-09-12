import type { RedpandaConnector } from '@rniverse/connectors/redpanda';
import type { ConsumerConfig, ConsumerRunConfig, EachMessagePayload, Producer, ProducerConfig } from 'kafkajs';
export declare function createKafkaProducer(connector: RedpandaConnector, config?: Partial<ProducerConfig>): {
    connect: () => Promise<void>;
    /** null when the producer never connected — caller decides the fallback. */
    get: () => Producer | null;
};
export type KafkaConsumerConfig = ConsumerConfig & {
    topic: string;
    fromBeginning?: boolean;
};
export declare function createKafkaConsumer(connector: RedpandaConnector, config: KafkaConsumerConfig): {
    subscribe: (onMessage: (payload: EachMessagePayload) => Promise<void>, runConfig?: Omit<ConsumerRunConfig, 'eachMessage'>) => Promise<void>;
};
//# sourceMappingURL=kafka.d.ts.map