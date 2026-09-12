import { log } from '@rniverse/utils';
// Generalizes the two Kafka-specific concerns every consumer of Redpanda
// hand-rolled: a best-effort producer (null if unreachable at startup —
// the caller decides whether that's fatal) and a consumer subscribe loop
// with group-join visibility. Message parsing/validation/rejection is
// domain-specific (it needs the caller's own DB tables) and stays with
// the caller — passed in as `onMessage`.
//
// Every kafkajs config type is forwarded through as-is, not narrowed to
// the couple of fields notify happens to use today — a wrapper that's
// less configurable than the connector it wraps defeats the point of
// sharing it: the next repo with different needs (a partitioner, a
// session timeout, eachBatch instead of eachMessage) would have nowhere
// to put that.
export function createKafkaProducer(connector, config) {
    let producer = null;
    async function connect() {
        try {
            producer = await connector.getProducer(config);
        }
        catch (err) {
            log.error(err, 'Kafka producer unavailable at startup');
        }
    }
    return {
        connect,
        /** null when the producer never connected — caller decides the fallback. */
        get: () => producer,
    };
}
export function createKafkaConsumer(connector, config) {
    async function subscribe(onMessage, runConfig) {
        const { topic, fromBeginning, ...consumerConfig } = config;
        const consumer = await connector.getConsumer(consumerConfig);
        await consumer.subscribe({ topic, fromBeginning: fromBeginning ?? false });
        log.info({ topic, groupId: config.groupId }, 'kafka.consumer: subscribed');
        // `subscribe`/`run` resolving doesn't mean the group finished joining —
        // that handshake runs against the broker in the background and can take
        // a few seconds. Logged so "hadn't joined yet" is visible, not guessed.
        consumer.on(consumer.events.GROUP_JOIN, ({ payload }) => {
            log.info({ groupId: config.groupId, memberId: payload.memberId }, 'kafka.consumer: group joined — ready to receive');
        });
        await consumer.run({ ...runConfig, eachMessage: onMessage });
    }
    return { subscribe };
}
//# sourceMappingURL=kafka.js.map