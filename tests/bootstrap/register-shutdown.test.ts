import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { registerShutdown } from '@lib/bootstrap';

describe('registerShutdown', () => {
	afterEach(() => {
		(process.exit as any).mockRestore?.();
	});

	test('unknownErrorListener runs onShutdown and exits 0 on success', async () => {
		const exit = spyOn(process, 'exit').mockImplementation((() => {}) as any);
		const onShutdown = mock(async () => {});

		const { unknownErrorListener } = registerShutdown({ onShutdown });
		await unknownErrorListener(new Error('boom'));

		expect(onShutdown).toHaveBeenCalledTimes(1);
		expect(onShutdown).toHaveBeenCalledWith('UNKNOWN_ERROR');
		expect(exit).toHaveBeenCalledWith(0);
	});

	test('exits 1 when onShutdown itself throws', async () => {
		const exit = spyOn(process, 'exit').mockImplementation((() => {}) as any);
		const onShutdown = mock(async () => {
			throw new Error('close failed');
		});

		const { unknownErrorListener } = registerShutdown({ onShutdown });
		await unknownErrorListener(new Error('boom'));

		expect(exit).toHaveBeenCalledWith(1);
	});

	test('runs the shutdown body at most once even if triggered twice', async () => {
		const exit = spyOn(process, 'exit').mockImplementation((() => {}) as any);
		const onShutdown = mock(async () => {});

		const { unknownErrorListener } = registerShutdown({ onShutdown });
		await Promise.all([
			unknownErrorListener(new Error('first')),
			unknownErrorListener(new Error('second')),
		]);

		expect(onShutdown).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledTimes(1);
	});
});

// The `process.listenerCount('SIGINT') === 0` dedup guard and the actual
// SIGINT/SIGTERM -> shutdown() -> process.exit() wiring only mean something
// end-to-end, in a process this test file doesn't itself pollute — run it in
// a real, disposable child process instead of the shared bun:test process.
describe('registerShutdown — real signal wiring (subprocess)', () => {
	test('SIGINT triggers onShutdown and a clean process.exit(0)', async () => {
		const script = `
			import { registerShutdown } from '${import.meta.dir}/../../lib/bootstrap.ts';
			registerShutdown({
				onShutdown: async (signal) => {
					console.log('SHUTDOWN:' + signal);
				},
			});
			console.log('READY');
		`;
		const proc = Bun.spawn(['bun', '-e', script], {
			stdout: 'pipe',
			stderr: 'pipe',
		});

		const output = proc.stdout;
		const reader = output.getReader();
		const decoder = new TextDecoder();
		let buffered = '';
		while (!buffered.includes('READY')) {
			const { value, done } = await reader.read();
			if (done) break;
			buffered += decoder.decode(value);
		}
		reader.releaseLock();

		proc.kill('SIGINT');
		const exitCode = await proc.exited;

		expect(exitCode).toBe(0);
	});
});
