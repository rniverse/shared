import { log } from '@rniverse/utils';
import { http, } from '@rniverse/utils/request';
// Generalizes the connection-lifecycle state machine (status + health
// aggregator + init/close), the per-service HTTP client map, and Kafka
// producer/consumer setup — all were hand-rolled identically per repo, only
// the connector/service/topic list ever differed. `required` on a
// ConnectionConfiguration drives both phases: a required connector failing
// to connect is fatal; an optional one is best-effort (logged, doesn't
// take init() down) at both connect and health-check time.
//
// Every accessor (`connections()`, `http()`, `kafka()`) is a getter, not a
// plain property — matches the `pg()`/`mail()` convention every consumer
// already uses for shared instances.
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
    const connect = async () => {
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
    return {
        state: () => state,
        setState: (next) => {
            state = next;
        },
        connect,
        close,
        health,
    };
}
function createHttp(configurations) {
    return new Map(configurations.map(({ name, ...clientConfig }) => [
        name,
        http(clientConfig),
    ]));
}
/**
 * Declarative — list what producers/consumers this app needs, `init()`
 * connects/subscribes all of them. Subscribing is as far as this goes:
 * `.run({eachMessage})` needs the caller's own message handler (domain
 * logic, e.g. it needs the caller's DB tables), so it's left to whoever
 * looks the consumer up by name afterward — see the `consumers/` directory
 * convention in each repo's own src.
 */
function createKafka(config) {
    const producers = new Map();
    const consumers = new Map();
    async function connectProducer(entry) {
        let producer = null;
        try {
            producer = await config.connector.getProducer(entry.config);
        }
        catch (err) {
            log.error(err, `Kafka producer '${entry.name}' unavailable at startup`);
        }
        producers.set(entry.name, producer);
    }
    async function subscribeConsumer(entry) {
        const { topic, fromBeginning, ...consumerConfig } = entry.consumer;
        const consumer = await config.connector.getConsumer(consumerConfig);
        await consumer.subscribe({ topic, fromBeginning: fromBeginning ?? false });
        log.info({ topic, groupId: entry.consumer.groupId }, `kafka.consumer '${entry.name}': subscribed`);
        // `subscribe` resolving doesn't mean the group finished joining — that
        // handshake runs against the broker in the background and can take a
        // few seconds. Logged so "hadn't joined yet" is visible, not guessed.
        consumer.on(consumer.events.GROUP_JOIN, ({ payload }) => {
            log.info({ groupId: entry.consumer.groupId, memberId: payload.memberId }, `kafka.consumer '${entry.name}': group joined — ready to receive`);
        });
        consumers.set(entry.name, consumer);
    }
    async function connect() {
        await Promise.all((config.producers ?? []).map(connectProducer));
        await Promise.all((config.consumers ?? []).map(subscribeConsumer));
    }
    return { connect, producers, consumers };
}
export function createRegistry(config) {
    const connections = createConnections(config.connections ?? []);
    const httpClients = createHttp(config.http ?? []);
    const kafka = config.kafka ? createKafka(config.kafka) : undefined;
    const init = async () => {
        connections.setState(CONNECTION_STATUS.INITIALIZING);
        await connections.connect();
        if (kafka)
            await kafka.connect();
        const report = await connections.health();
        connections.setState(CONNECTION_STATUS.READY);
        return report;
    };
    return {
        connections: () => ({
            init,
            close: connections.close,
            health: connections.health,
            status: connections.state,
        }),
        http: () => httpClients,
        kafka: () => kafka,
    };
}
//# sourceMappingURL=registry.js.map