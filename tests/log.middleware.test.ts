import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { logger } from '@middlewares/log.middleware';
import { cxt$req } from '@rniverse/utils/context';
import { log } from '@rniverse/utils/logger';
import Elysia from 'elysia';

function buildApp() {
	return new Elysia()
		.use(logger())
		.get('/ping', () => 'pong')
		.get('/fail', ({ set }) => {
			set.status = 500;
			return 'boom';
		});
}

// `onAfterResponse` fires after the response is already handed back —
// `app.handle()` resolving doesn't guarantee it has run yet. Poll briefly
// instead of assuming a fixed delay is long enough.
async function waitFor(predicate: () => boolean, timeoutMs = 200) {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error('waitFor: condition never became true');
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe('log.middleware — logger()', () => {
	afterEach(() => {
		(log.info as any).mockRestore?.();
		(log.error as any).mockRestore?.();
	});

	test('logs a start and a completed line for a successful request', async () => {
		const info = spyOn(log, 'info');
		const app = buildApp();

		await cxt$req.run({ requestId: 'req-1' }, () =>
			app.handle(new Request('http://localhost/ping')),
		);
		await waitFor(() => info.mock.calls.length >= 2);

		const lines = info.mock.calls.map((call) => call[0]);
		expect(lines.some((line) => line.includes('Request started'))).toBe(true);
		expect(lines.some((line) => line.includes('Request completed'))).toBe(true);
	});

	test('strips the querystring — path only, never the raw url', async () => {
		const info = spyOn(log, 'info');
		const app = buildApp();

		await cxt$req.run({ requestId: 'req-2' }, () =>
			app.handle(new Request('http://localhost/ping?code=secret&state=xyz')),
		);
		await waitFor(() => info.mock.calls.length >= 2);

		const lines = info.mock.calls.map((call) => String(call[0]));
		for (const line of lines) {
			expect(line).not.toContain('secret');
			expect(line).not.toContain('code=');
		}
		expect(lines.some((line) => line.includes('/ping'))).toBe(true);
	});

	test('logs the completion line at error level for a 4xx/5xx response', async () => {
		const error = spyOn(log, 'error');
		const app = buildApp();

		await cxt$req.run({ requestId: 'req-3' }, () =>
			app.handle(new Request('http://localhost/fail')),
		);
		await waitFor(() => error.mock.calls.length >= 1);

		const lines = error.mock.calls.map((call) => String(call[0]));
		expect(
			lines.some(
				(line) => line.includes('Request completed') && line.includes('500'),
			),
		).toBe(true);
	});

	test('sets x-request-id on the response when a requestId is in context', async () => {
		const app = buildApp();

		const response = await cxt$req.run({ requestId: 'req-4' }, () =>
			app.handle(new Request('http://localhost/ping')),
		);

		expect(response.headers.get('x-request-id')).toBe('req-4');
	});

	// `pathOf()`'s catch branch (an unparsable `request.url`) isn't exercised
	// here — Bun/undici's `Request` always carries a valid absolute URL, so
	// that branch is unreachable through the real request path this plugin
	// runs on. Left uncovered rather than faked with a call this code can't
	// actually receive.
});
