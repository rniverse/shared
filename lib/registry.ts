import type { RedpandaConnector } from '@rniverse/connectors/redpanda';
import { log } from '@rniverse/utils';
import {
	type ClientConfig,
	type HttpClient,
	http,
} from '@rniverse/utils/request';
import type { Result } from '@rniverse/utils/result';
import type {
	Consumer,
	ConsumerConfig,
	ConsumerGroupJoinEvent,
	Producer,
	ProducerConfig,
} from 'kafkajs';

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

export type HttpConfiguration = ClientConfig & { name: string };

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

function createHttp(
	configurations: HttpConfiguration[],
): Map<string, HttpClient> {
	return new Map(
		configurations.map(({ name, ...clientConfig }) => [
			name,
			http(clientConfig),
		]),
	);
}

export type KafkaConsumerConfig = ConsumerConfig & {
	topic: string;
	fromBeginning?: boolean;
};

/**
 * `name` is the actual registry key (what `producers.get()`/`.run()` look
 * up) — deliberately not the object key the caller declares this under.
 * Decouples the stable, typo-checked TS property (`config.kafka.producers.
 * notifier`) from the runtime label (env-driven, shows up in log lines,
 * can differ per deployment without a code change).
 */
export type KafkaProducerConfiguration = Partial<ProducerConfig> & {
	name: string;
};

export type KafkaConsumerConfiguration = KafkaConsumerConfig & {
	name: string;
};

/**
 * Declarative — list what producers/consumers this app needs, `init()`
 * connects/subscribes all of them. Subscribing is as far as this goes:
 * `.run({eachMessage})` needs the caller's own message handler (domain
 * logic, e.g. it needs the caller's DB tables), so it's left to whoever
 * looks the consumer up by name afterward — see the `consumers/` directory
 * convention in each repo's own src.
 */
function createKafka(config: {
	connector: RedpandaConnector;
	producers?: Record<string, KafkaProducerConfiguration>;
	consumers?: Record<string, KafkaConsumerConfiguration>;
}) {
	const producers = new Map<string, Producer | null>();
	const consumers = new Map<string, Consumer>();

	async function connectProducer(
		entry: KafkaProducerConfiguration,
	): Promise<void> {
		const { name, ...producerConfig } = entry;
		let producer: Producer | null = null;
		try {
			producer = await config.connector.getProducer(producerConfig);
		} catch (err) {
			log.error(err, `Kafka producer '${name}' unavailable at startup`);
		}
		producers.set(name, producer);
	}

	async function subscribeConsumer(
		entry: KafkaConsumerConfiguration,
	): Promise<void> {
		const { name, topic, fromBeginning, ...consumerConfig } = entry;
		const consumer = await config.connector.getConsumer(consumerConfig);
		await consumer.subscribe({ topic, fromBeginning: fromBeginning ?? false });
		log.info(
			{ topic, groupId: entry.groupId },
			`kafka.consumer '${name}': subscribed`,
		);
		// `subscribe` resolving doesn't mean the group finished joining — that
		// handshake runs against the broker in the background and can take a
		// few seconds. Logged so "hadn't joined yet" is visible, not guessed.
		consumer.on(
			consumer.events.GROUP_JOIN,
			({ payload }: ConsumerGroupJoinEvent) => {
				log.info(
					{ groupId: entry.groupId, memberId: payload.memberId },
					`kafka.consumer '${name}': group joined — ready to receive`,
				);
			},
		);
		consumers.set(name, consumer);
	}

	async function connect(): Promise<void> {
		await Promise.all(
			Object.values(config.producers ?? {}).map(connectProducer),
		);
		await Promise.all(
			Object.values(config.consumers ?? {}).map(subscribeConsumer),
		);
	}

	return { connect, producers, consumers };
}

export function createRegistry(config: {
	connections?: ConnectionConfiguration[];
	http?: HttpConfiguration[];
	/** Pass the same connector instance also listed in `connections` — kafka
	 * needs the concrete RedpandaConnector (getProducer/getConsumer), not the
	 * generic connect/close/health shape `connections` tracks it under. */
	kafka?: {
		connector: RedpandaConnector;
		producers?: Record<string, KafkaProducerConfiguration>;
		consumers?: Record<string, KafkaConsumerConfiguration>;
	};
}) {
	const connections = createConnections(config.connections ?? []);
	const httpClients = createHttp(config.http ?? []);
	const kafka = config.kafka ? createKafka(config.kafka) : undefined;

	const init = async (): Promise<HealthReport> => {
		connections.setState(CONNECTION_STATUS.INITIALIZING);
		await connections.connect();
		if (kafka) await kafka.connect();
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
