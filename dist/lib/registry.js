import { log } from '@rniverse/utils';
import { http, } from '@rniverse/utils/request';
// Generalizes the connection-lifecycle state machine (status + health
// aggregator + init/close) and the per-service HTTP client map — both were
// hand-rolled identically per repo, only the connector/service list ever
// differed. `required` on a ConnectionConfiguration drives both phases: a
// required connector failing to connect is fatal; an optional one is
// best-effort (logged, doesn't take init() down) at both connect and
// health-check time.
//
// Kafka producers / consumers are not here: `@rniverse/connectors` owns their
// lifecycle (`KafkaConnector.producer()` / `.consumer()` links, tracked,
// health-checked and closed with their connector). The owning service creates
// and runs them.
//
// Every accessor (`connections()`, `http()`) is a getter, not a plain
// property — matches the `pg()` convention consumers use for shared instances.
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
export function createRegistry(config) {
    const connections = createConnections(config.connections ?? []);
    const httpClients = createHttp(config.http ?? []);
    const init = async () => {
        connections.setState(CONNECTION_STATUS.INITIALIZING);
        await connections.connect();
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
    };
}
//# sourceMappingURL=registry.js.map