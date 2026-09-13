import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createRegistry } from '@lib/registry';
import { RedpandaConnector } from '@rniverse/connectors/redpanda';

const BROKER = process.env.KAFKA_BOOTSTRAP_SERVERS!;

async function waitFor<T>(get: () => T[], count: number, timeoutMs = 10_000) {
	const start = Date.now();
	while (get().length < count) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`waitFor: only got ${get().length}/${count} messages`);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe('createRegistry — kafka', () => {
	test('kafka() is undefined when no kafka config is passed', () => {
		const registry = createRegistry({});
		expect(registry.kafka()).toBeUndefined();
	});
});

describe('createRegistry — kafka, against a real broker', () => {
	const connector = new RedpandaConnector({ url: BROKER });
	const topic = `shared-registry-test-${Date.now()}`;

	beforeAll(async () => {
		const admin = await connector.getAdmin();
		await admin.createTopics({
			topics: [{ topic, numPartitions: 1, replicationFactor: 1 }],
		});
	});

	afterAll(async () => {
		const admin = await connector.getAdmin();
		await admin.deleteTopics({ topics: [topic] }).catch(() => {});
		await connector.close();
	});

	test('producer/consumer are keyed by their declared `name`, not the config object key', async () => {
		const registry = createRegistry({
			kafka: {
				connector,
				producers: {
					publisher: { name: 'custom-producer-name' },
				},
				consumers: {
					subscriber: {
						name: 'custom-consumer-name',
						groupId: `shared-test-group-${Date.now()}`,
						topic,
					},
				},
			},
		});

		await registry.kafka()!.connect();

		expect(
			registry.kafka()!.producers.get('custom-producer-name'),
		).toBeTruthy();
		expect(registry.kafka()!.producers.get('publisher')).toBeUndefined();
		expect(
			registry.kafka()!.consumers.get('custom-consumer-name'),
		).toBeTruthy();
		expect(registry.kafka()!.consumers.get('subscriber')).toBeUndefined();
	});

	test('end-to-end: publish through the registered producer, subscribe/run the registered consumer, message arrives', async () => {
		const groupId = `shared-test-group-${Date.now()}`;
		const registry = createRegistry({
			kafka: {
				connector,
				producers: { main: { name: 'e2e-producer' } },
				consumers: {
					main: { name: 'e2e-consumer', groupId, topic, fromBeginning: false },
				},
			},
		});

		await registry.kafka()!.connect();

		const received: string[] = [];
		const consumer = registry.kafka()!.consumers.get('e2e-consumer')!;
		await consumer.run({
			eachMessage: async ({ message }) => {
				received.push(message.value?.toString() ?? '');
			},
		});
		// `subscribe()` resolving doesn't mean the group has finished joining
		// (registry.ts logs this explicitly) — give it a moment before
		// producing, or the first message can be missed.
		await new Promise((resolve) => setTimeout(resolve, 1000));

		const producer = registry.kafka()!.producers.get('e2e-producer')!;
		await producer!.send({
			topic,
			messages: [{ value: 'hello from the registry' }],
		});

		await waitFor(() => received, 1);
		expect(received).toContain('hello from the registry');
	});

	test('a producer that fails to connect is stored as null, not thrown', async () => {
		const brokenConnector = {
			getProducer: async () => {
				throw new Error('broker unreachable');
			},
			getConsumer: connector.getConsumer.bind(connector),
		} as unknown as RedpandaConnector;

		const registry = createRegistry({
			kafka: {
				connector: brokenConnector,
				producers: { main: { name: 'never-connects' } },
			},
		});

		await registry.kafka()!.connect();

		expect(registry.kafka()!.producers.has('never-connects')).toBe(true);
		expect(registry.kafka()!.producers.get('never-connects')).toBeNull();
	});
});
