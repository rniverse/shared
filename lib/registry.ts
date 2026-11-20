import { log } from '@rniverse/utils';
import {
	type ClientConfig,
	type HttpClient,
	http,
} from '@rniverse/utils/request';
import type { Result } from '@rniverse/utils/result';

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
} as const;
export type ConnectionStatus =
	(typeof CONNECTION_STATUS)[keyof typeof CONNECTION_STATUS];

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

/**
 * `required` works like a connection's for the health report only: an
 * unhealthy required service takes working state down. No HTTP service is
 * checked at `init()` — boot never waits on another service being up.
 */
export type HttpConfiguration = ClientConfig & {
	name: string;
	required: boolean;
};

/** One entry in the health report — a connection or an HTTP service. */
type HealthEntry = {
	name: string;
	required: boolean;
	health(): Promise<Result<unknown>>;
};

export type HealthReport = {
	ok: boolean;
	isInWorkingState: boolean;
	services: Record<string, { ok: boolean; error?: unknown }>;
};

function createConnections(
	configurations: ConnectionConfiguration[],
	services: HealthEntry[],
) {
	let state: ConnectionStatus = CONNECTION_STATUS.IDLE;
	const entries: HealthEntry[] = [
		...configurations.map((c) => ({
			name: c.name,
			required: c.required,
			health: () => c.connector.health(),
		})),
		...services,
	];

	const health = async (): Promise<HealthReport> => {
		const results = await Promise.all(
			entries.map(async (c) => ({
				c,
				result: await c.health(),
			})),
		);
		let isInWorkingState = true;
		const services: HealthReport['services'] = {};
		for (const { c, result } of results) {
			if (!result.ok) {
				log.error(result.error, `HEALTH CHECK: ${c.name} failed:`);
				if (c.required) isInWorkingState = false;
			}
			services[c.name] = result;
		}
		const ok = results.every(({ result }) => result.ok);
		if (ok) {
			log.info('All connections and services are healthy');
		} else if (isInWorkingState) {
			log.warn(
				services,
				'Some connections or services are unhealthy, but working state is OK:',
			);
		} else {
			log.error(
				services,
				'Not in working state, some required connections or services are unhealthy',
			);
		}
		return { ok, isInWorkingState, services };
	};

	const connect = async (): Promise<void> => {
		const required = configurations.filter((c) => c.required);
		const optional = configurations.filter((c) => !c.required);

		await Promise.all(required.map((c) => c.connector.connect())).catch(
			(err) => {
				log.error(err, 'Error initializing required connections');
				state = CONNECTION_STATUS.ERROR;
				process.exit(1);
			},
		);
		// Best-effort — an optional connector unreachable at startup doesn't
		// take the process down, only its own health entry reports unhealthy.
		// Not awaited: an optional connection never holds up boot.
		for (const c of optional) {
			c.connector.connect().catch((err) => {
				log.warn(err, `Optional connection '${c.name}' unavailable at startup`);
			});
		}
	};

	const close = async (): Promise<void> => {
		state = CONNECTION_STATUS.CLOSING;
		await Promise.all(configurations.map((c) => c.connector.close())).catch(
			(err) => {
				log.error(err, 'Error closing connections');
				state = CONNECTION_STATUS.ERROR;
				process.exit(1);
			},
		);
		state = CONNECTION_STATUS.CLOSED;
	};

	return {
		state: () => state,
		setState: (next: ConnectionStatus) => {
			state = next;
		},
		connect,
		close,
		health,
	};
}

export function createRegistry(config: {
	connections?: ConnectionConfiguration[];
	http?: HttpConfiguration[];
}) {
	const configured = [...(config.connections ?? []), ...(config.http ?? [])];
	const names = new Set<string>();
	for (const { name } of configured) {
		// Health report entries are keyed by name — a clash would hide one.
		if (names.has(name)) throw new Error(`registry: duplicate name '${name}'`);
		names.add(name);
	}

	const clients = (config.http ?? []).map(
		({ name, required, ...clientConfig }) => ({
			name,
			required,
			client: http(clientConfig),
		}),
	);
	const httpClients = new Map<string, HttpClient>(
		clients.map((c) => [c.name, c.client]),
	);
	const services: HealthEntry[] = clients.map(({ name, required, client }) => ({
		name,
		required,
		health: () => client.health(),
	}));
	const connections = createConnections(config.connections ?? [], services);

	/** Required connections awaited, optional ones started in the background. No health check. */
	const init = async (): Promise<void> => {
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
