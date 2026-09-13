import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { boot } from '@lib/bootstrap';
import { cxt$req } from '@rniverse/utils/context';

describe('boot', () => {
	afterEach(() => {
		(Bun.serve as any).mockRestore?.();
		(process.exit as any).mockRestore?.();
	});

	test('runs init() inside a request context seeded with requestId "SERVER_LOG"', async () => {
		spyOn(Bun, 'serve').mockReturnValue({} as any);
		let seenRequestId: string | undefined;

		const init = mock(async () => {
			seenRequestId = cxt$req.requestId();
			return { handle: () => new Response('ok') };
		});

		boot(init, { port: 0, host: 'localhost' }, async () => {});
		// boot() is fire-and-forget (no returned promise) — wait for the
		// microtask chain (init -> listen) to actually run.
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(seenRequestId).toBe('SERVER_LOG');
	});

	test('calls listen() with the app init() resolved and the given server config', async () => {
		const serve = spyOn(Bun, 'serve').mockReturnValue({} as any);
		const handle = () => new Response('ok');
		const init = mock(async () => ({ handle }));

		boot(init, { port: 5555, host: '0.0.0.0' }, async () => {});
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(serve).toHaveBeenCalledTimes(1);
		const [config] = serve.mock.calls[0]!;
		expect(config.port).toBe(5555);
		expect(config.hostname).toBe('0.0.0.0');
		expect(config.fetch).toBe(handle);
	});

	test('a rejected init() runs onShutdown via the unknown-error path and exits 0 on clean shutdown', async () => {
		const exit = spyOn(process, 'exit').mockImplementation((() => {}) as any);
		const onShutdown = mock(async () => {});
		const init = mock(async () => {
			throw new Error('startup failed');
		});

		boot(init, { port: 0, host: 'localhost' }, onShutdown);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(onShutdown).toHaveBeenCalledWith('UNKNOWN_ERROR');
		expect(exit).toHaveBeenCalledWith(0);
	});
});
