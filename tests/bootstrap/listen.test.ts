import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { listen } from '@lib/bootstrap';

describe('listen', () => {
	afterEach(() => {
		(Bun.serve as any).mockRestore?.();
	});

	test('calls Bun.serve with the given port/host and the app.handle fetch, returns the server', () => {
		const fakeServer = { hostname: 'localhost', port: 4321 };
		const serve = spyOn(Bun, 'serve').mockReturnValue(fakeServer as any);

		const handle = () => new Response('ok');
		const server = listen({ handle }, { port: 4321, host: 'localhost' });

		expect(serve).toHaveBeenCalledTimes(1);
		const [config] = serve.mock.calls[0]!;
		expect(config.port).toBe(4321);
		expect(config.hostname).toBe('localhost');
		expect(config.fetch).toBe(handle);
		expect(server).toBe(fakeServer);
	});
});
