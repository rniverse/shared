import { log } from '@rniverse/utils';
import { http, } from '@rniverse/utils/request';
// Generalizes the connection-lifecycle state machine (status + health
// aggregator + init/close) and the per-service HTTP client map (whose
// services join the same health report) — both were
// hand-rolled identically per repo, only the connector/service list ever
// differed. `required` on a ConnectionConfiguration: a required connector is
// awaited at init() and failing to connect is fatal; an optional one connects
// in the background — it never holds up boot, a failure is only logged — and
// being unhealthy doesn't take the working state down. init() runs no health
// check; health runs only when asked (e.g. `/api/health`).
//
// Kafka producers / consumers are not here: `@rniverse/connectors` declares
// them in the `KafkaConnector`'s config and connects them with it; the owning
// service only subscribes / runs.
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
function createConnections(configurations, services) {
    let state = CONNECTION_STATUS.IDLE;
    const entries = [
        ...configurations.map((c) => ({
            name: c.name,
            required: c.required,
            health: () => c.connector.health(),
        })),
        ...services,
    ];
    const health = async () => {
        const results = await Promise.all(entries.map(async (c) => ({
            c,
            result: await c.health(),
        })));
        let isInWorkingState = true;
        const services = {};
        for (const { c, result } of results) {
            if (!result.ok) {
                log.error(result.error, `HEALTH CHECK: ${c.name} failed:`);
                if (c.required)
                    isInWorkingState = false;
            }
            services[c.name] = result;
        }
        const ok = results.every(({ result }) => result.ok);
        if (ok) {
            log.info('All connections and services are healthy');
        }
        else if (isInWorkingState) {
            log.warn(services, 'Some connections or services are unhealthy, but working state is OK:');
        }
        else {
            log.error(services, 'Not in working state, some required connections or services are unhealthy');
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
        // Not awaited: an optional connection never holds up boot.
        for (const c of optional) {
            c.connector.connect().catch((err) => {
                log.warn(err, `Optional connection '${c.name}' unavailable at startup`);
            });
        }
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
export function createRegistry(config) {
    const configured = [...(config.connections ?? []), ...(config.http ?? [])];
    const names = new Set();
    for (const { name } of configured) {
        // Health report entries are keyed by name — a clash would hide one.
        if (names.has(name))
            throw new Error(`registry: duplicate name '${name}'`);
        names.add(name);
    }
    const clients = (config.http ?? []).map(({ name, required, ...clientConfig }) => ({
        name,
        required,
        client: http(clientConfig),
    }));
    const httpClients = new Map(clients.map((c) => [c.name, c.client]));
    const services = clients.map(({ name, required, client }) => ({
        name,
        required,
        health: () => client.health(),
    }));
    const connections = createConnections(config.connections ?? [], services);
    /** Required connections awaited, optional ones started in the background. No health check. */
    const init = async () => {
        connections.setState(CONNECTION_STATUS.INITIALIZING);
        await connections.connect();
        connections.setState(CONNECTION_STATUS.READY);
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