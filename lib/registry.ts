import { log } from '@rniverse/utils';
import {
	type ClientConfig,
	type HttpClient,
	http,
} from '@rniverse/utils/request';
import type { Result } from '@rniverse/utils/result';
import {
	createHealth,
	type HealthOptions,
	type Phase,
	type Probe,
} from './health';

// Generalizes the connection-lifecycle state machine (status + init/close),
// the per-service HTTP client map, and their health checks — all were
// hand-rolled identically per repo, only the connector/service list ever
// differed. `required` on a ConnectionConfiguration: a required connector is
// awaited at init() and failing to connect is fatal; an optional one connects
// in the background — it never holds up boot, a failure is only logged — and
// it never fails readiness. HTTP services are never required: they show in
// `health.details()` only, so another service being down never takes this
// one out (see `lib/health.ts`).
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
	/** A connectors link's circuit-breaker state. */
	readonly circuit?: string;
	/** A connectors link's events; the registry listens to `fail`. */
	on?(
		type: 'fail',
		listener: { name: string; handler: (event: { error: unknown }) => unknown },
	): void;
};

export type ConnectionConfiguration = {
	name: string;
	connector: Connector;
	required: boolean;
};

/** An HTTP service. Never required — it shows in `health.details()` only. */
export type HttpConfiguration = ClientConfig & { name: string };

export type RegistryHealthOptions = HealthOptions & {
	/** HTTP services: attempts per check. Default 1 (no retries). */
	attempts?: number;
	/** HTTP services: ms per attempt. Default 5_000. */
	timeout?: number;
};

const HTTP_HEALTH_DEFAULTS = { attempts: 1, timeout: 5_000 } as const;

function phaseOf(state: ConnectionStatus): Phase {
	if (state === CONNECTION_STATUS.READY) return 'ready';
	if (
		state === CONNECTION_STATUS.IDLE ||
		state === CONNECTION_STATUS.INITIALIZING
	) {
		return 'starting';
	}
	return 'closing';
}

export function createRegistry(config: {
	/** This service's name, shown in `health.details()`. */
	name: string;
	version?: string;
	connections?: ConnectionConfiguration[];
	http?: HttpConfiguration[];
	health?: RegistryHealthOptions;
}) {
	const configurations = config.connections ?? [];
	const names = new Set<string>();
	for (const { name } of [...configurations, ...(config.http ?? [])]) {
		// Health checks are keyed by name — a clash would hide one.
		if (names.has(name)) throw new Error(`registry: duplicate name '${name}'`);
		names.add(name);
	}

	let state: ConnectionStatus = CONNECTION_STATUS.IDLE;

	const clients = (config.http ?? []).map(({ name, ...clientConfig }) => ({
		name,
		client: http(clientConfig),
	}));
	const httpClients = new Map<string, HttpClient>(
		clients.map((c) => [c.name, c.client]),
	);

	const attempts = config.health?.attempts ?? HTTP_HEALTH_DEFAULTS.attempts;
	const timeout = config.health?.timeout ?? HTTP_HEALTH_DEFAULTS.timeout;
	const probes: Probe[] = [
		...configurations.map(
			({ name, connector, required }): Probe => ({
				name,
				kind: 'connection',
				required,
				check: () => connector.health(),
				circuit: () => connector.circuit,
				watch: connector.on
					? (onFail) =>
							connector.on?.('fail', {
								name: `health:${config.name}`,
								handler: ({ error }) => onFail(error),
							})
					: undefined,
			}),
		),
		...clients.map(
			({ name, client }): Probe => ({
				name,
				kind: 'service',
				required: false,
				check: () => client.health({ retries: attempts - 1, timeout }),
			}),
		),
	];

	const health = createHealth({
		name: config.name,
		version: config.version,
		probes,
		phase: () => phaseOf(state),
		options: config.health,
	});

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
		// take the process down, only its own health entry reports it.
		// Not awaited: an optional connection never holds up boot.
		for (const c of optional) {
			c.connector.connect().catch((err) => {
				log.warn(err, `Optional connection '${c.name}' unavailable at startup`);
			});
		}
	};

	/**
	 * Required connections awaited, optional ones started in the background,
	 * then one non-fatal health check of everything so the cache is filled
	 * before the first request.
	 */
	const init = async (): Promise<void> => {
		state = CONNECTION_STATUS.INITIALIZING;
		await connect();
		// READY first so the report reflects the checks, not the boot phase.
		// The server isn't listening yet, so nothing reads it in between.
		state = CONNECTION_STATUS.READY;
		const { body } = await health.details();
		const level = body.status === 'pass' ? 'info' : 'warn';
		log[level](body.checks, `Health at startup: ${body.status}`);
	};

	const close = async (): Promise<void> => {
		// Readiness answers 503 from here on, so a load balancer stops routing
		// before the connections go.
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
		connections: () => ({ init, close, status: () => state }),
		http: () => httpClients,
		health,
	};
}
