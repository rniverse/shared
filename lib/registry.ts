import { log } from '@rniverse/utils';
import {
	type ClientConfig,
	type HttpClient,
	http,
} from '@rniverse/utils/request';
import type { Result } from '@rniverse/utils/result';

// Generalizes the connection-lifecycle state machine (status + health
// aggregator + init/close) and the per-service HTTP client map — both
// were hand-rolled identically per repo, only the connector/service list
// ever differed. `required` on a ConnectionConfiguration drives both
// phases: a required connector failing to connect is fatal; an optional
// one is best-effort (logged, doesn't take init() down) at both connect
// and health-check time.

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

type Connector = {
	// `unknown` on purpose — RedpandaConnector.connect() resolves an Admin
	// client, SQLConnector resolves void; the registry never reads the value.
	connect(): Promise<unknown>;
	close(): Promise<void>;
	health(): Promise<Result<void>>;
};

export type ConnectionConfiguration = {
	name: string;
	connector: Connector;
	required: boolean;
};

export type HttpServiceConfiguration = ClientConfig & { name: string };

export type HealthReport = {
	ok: boolean;
	isInWorkingState: boolean;
	services: Record<string, { ok: boolean; error?: unknown }>;
};

function createConnections(configurations: ConnectionConfiguration[]) {
	let state: ConnectionStatus = CONNECTION_STATUS.IDLE;

	const health = async (): Promise<HealthReport> => {
		const results = await Promise.all(
			configurations.map(async (c) => ({
				c,
				result: await c.connector.health(),
			})),
		);
		let isInWorkingState = true;
		const services: HealthReport['services'] = {};
		for (const { c, result } of results) {
			if (!result.ok) {
				log.error(result.error, `HEALTH CHECK: ${c.name} connection failed:`);
				if (c.required) isInWorkingState = false;
			}
			services[c.name] = result;
		}
		const ok = results.every(({ result }) => result.ok);
		if (ok) {
			log.info('All connections are healthy');
		} else if (isInWorkingState) {
			log.warn(
				services,
				'Some connections are unhealthy, but working state is OK:',
			);
		} else {
			log.error(
				services,
				'Not in working state, some critical connections are unhealthy',
			);
		}
		return { ok, isInWorkingState, services };
	};

	const init = async (): Promise<HealthReport> => {
		state = CONNECTION_STATUS.INITIALIZING;
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
		await Promise.all(
			optional.map((c) =>
				c.connector.connect().catch((err) => {
					log.error(
						err,
						`Optional connection '${c.name}' unavailable at startup`,
					);
				}),
			),
		);

		const report = await health();
		state = CONNECTION_STATUS.READY;
		return report;
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

	return { init, close, health, status: () => state };
}

function createServices(
	configurations: HttpServiceConfiguration[],
): Record<string, HttpClient> {
	return Object.fromEntries(
		configurations.map(({ name, ...clientConfig }) => [
			name,
			http(clientConfig),
		]),
	);
}

export function createRegistry(config: {
	connections?: ConnectionConfiguration[];
	services?: HttpServiceConfiguration[];
}) {
	return {
		connections: createConnections(config.connections ?? []),
		services: createServices(config.services ?? []),
	};
}
