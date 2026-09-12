import { log } from '@rniverse/utils';
import { http, } from '@rniverse/utils/request';
// Generalizes the connection-lifecycle state machine (status + health
// aggregator + init/close), the per-service HTTP client map, and Kafka
// producer/consumer registration — all were hand-rolled identically per
// repo, only the connector/service list ever differed. `required` on a
// ConnectionConfiguration drives both phases: a required connector failing
// to connect is fatal; an optional one is best-effort (logged, doesn't
// take init() down) at both connect and health-check time.
export const CONNECTION_STATUS = {
    IDLE: 'idle',
    INITIALIZING: 'initializing',
    READY: 'ready',
    CLOSING: 'closing',
    ERROR: 'error',
    CLOSED: 'closed',
};
function createConnections(configurations) {
    let state = CONNECTION_STATUS.IDLE;
    const health = async () => {
        const results = await Promise.all(configurations.map(async (c) => ({
            c,
            result: await c.connector.health(),
        })));
        let isInWorkingState = true;
        const services = {};
        for (const { c, result } of results) {
            if (!result.ok) {
                log.error(result.error, `HEALTH CHECK: ${c.name} connection failed:`);
                if (c.required)
                    isInWorkingState = false;
            }
            services[c.name] = result;
        }
        const ok = results.every(({ result }) => result.ok);
        if (ok) {
            log.info('All connections are healthy');
        }
        else if (isInWorkingState) {
            log.warn(services, 'Some connections are unhealthy, but working state is OK:');
        }
        else {
            log.error(services, 'Not in working state, some critical connections are unhealthy');
        }
        return { ok, isInWorkingState, services };
    };
    const init = async () => {
        state = CONNECTION_STATUS.INITIALIZING;
        const required = configurations.filter((c) => c.required);
        const optional = configurations.filter((c) => !c.required);
        await Promise.all(required.map((c) => c.connector.connect())).catch((err) => {
            log.error(err, 'Error initializing required connections');
            state = CONNECTION_STATUS.ERROR;
            process.exit(1);
        });
        // Best-effort — an optional connector unreachable at startup doesn't
        // take the process down, only its own health entry reports unhealthy.
        await Promise.all(optional.map((c) => c.connector.connect().catch((err) => {
            log.error(err, `Optional connection '${c.name}' unavailable at startup`);
        })));
        const report = await health();
        state = CONNECTION_STATUS.READY;
        return report;
    };
    const close = async () => {
        state = CONNECTION_STATUS.CLOSING;
        await Promise.all(configurations.map((c) => c.connector.close())).catch((err) => {
            log.error(err, 'Error closing connections');
            state = CONNECTION_STATUS.ERROR;
            process.exit(1);
        });
        state = CONNECTION_STATUS.CLOSED;
    };
    return { init, close, health, status: () => state };
}
function createServices(configurations) {
    return Object.fromEntries(configurations.map(({ name, ...clientConfig }) => [
        name,
        http(clientConfig),
    ]));
}
/**
 * Registration, not raw passthrough — `connector.getProducer()`/
 * `getConsumer()` already take their own real kafkajs config, so this adds
 * only what's actually shared logic: a best-effort producer (null, not a
 * crash, if Kafka is down at startup — caller decides the fallback) and a
 * consumer subscribe with group-join visibility, both stashed under one
 * registry instead of hand-rolled at each call site.
 */
function createKafka(connector) {
    const producers = {};
    async function registerProducer(name, config) {
        let producer = null;
        try {
            producer = await connector.getProducer(config);
        }
        catch (err) {
            log.error(err, `Kafka producer '${name}' unavailable at startup`);
        }
        producers[name] = producer;
        return producer;
    }
    async function registerConsumer(config, onMessage, runConfig) {
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
    return {
        register: { producer: registerProducer, consumer: registerConsumer },
        registry: { producers },
    };
}
export function createRegistry(config) {
    return {
        connections: createConnections(config.connections ?? []),
        services: createServices(config.services ?? []),
        kafka: config.kafka ? createKafka(config.kafka.connector) : undefined,
    };
}
//# sourceMappingURL=registry.js.map