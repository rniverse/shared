import type { RedpandaConnector } from '@rniverse/connectors/redpanda';
import { log } from '@rniverse/utils';
import type {
	ConsumerGroupJoinEvent,
	EachMessagePayload,
	Producer,
} from 'kafkajs';

// Generalizes the two Kafka-specific concerns every consumer of Redpanda
// hand-rolled: a best-effort producer (null if unreachable at startup —
// the caller decides whether that's fatal) and a consumer subscribe loop
// with group-join visibility. Message parsing/validation/rejection is
// domain-specific (it needs the caller's own DB tables) and stays with
// the caller — passed in as `onMessage`.

export function createKafkaProducer(connector: RedpandaConnector) {
	let producer: Producer | null = null;

	async function connect(): Promise<void> {
		try {
			producer = await connector.getProducer();
		} catch (err) {
			log.error(err, 'Kafka producer unavailable at startup');
		}
	}

	return {
		connect,
		/** null when the producer never connected — caller decides the fallback. */
		get: () => producer,
	};
}

export type KafkaConsumerConfig = {
	groupId: string;
	topic: string;
	fromBeginning?: boolean;
};

export function createKafkaConsumer(
	connector: RedpandaConnector,
	config: KafkaConsumerConfig,
) {
	async function subscribe(
		onMessage: (payload: EachMessagePayload) => Promise<void>,
	): Promise<void> {
		const consumer = await connector.getConsumer({ groupId: config.groupId });
		await consumer.subscribe({
			topic: config.topic,
			fromBeginning: config.fromBeginning ?? false,
		});
		log.info(
			{ topic: config.topic, groupId: config.groupId },
			'kafka.consumer: subscribed',
		);
		// `subscribe`/`run` resolving doesn't mean the group finished joining —
		// that handshake runs against the broker in the background and can take
		// a few seconds. Logged so "hadn't joined yet" is visible, not guessed.
		consumer.on(
			consumer.events.GROUP_JOIN,
			({ payload }: ConsumerGroupJoinEvent) => {
				log.info(
					{ groupId: config.groupId, memberId: payload.memberId },
					'kafka.consumer: group joined — ready to receive',
				);
			},
		);
		await consumer.run({ eachMessage: onMessage });
	}

	return { subscribe };
}
