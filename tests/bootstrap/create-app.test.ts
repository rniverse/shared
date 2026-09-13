import { describe, expect, test } from 'bun:test';
import { createApp } from '@lib/bootstrap';
import { createErrorEnum } from '@lib/error';
import Elysia, { t } from 'elysia';
import * as v from 'valibot';

const enums = createErrorEnum([
	['NOT_FOUND', 'Not found', 404],
	['VALIDATION_FAILED', 'Validation failed', 422],
	['INTERNAL_ERROR', 'Internal error', 500],
	['CUSTOM_ERROR', 'Custom error', 409],
] as const);

const errors = {
	AppError: enums.AppError,
	NOT_FOUND: enums.spec('NOT_FOUND'),
	VALIDATION_FAILED: enums.spec('VALIDATION_FAILED'),
	INTERNAL_ERROR: enums.spec('INTERNAL_ERROR'),
};

function buildApi() {
	return new Elysia()
		.get('/ok', () => ({ ok: true, data: 'hi' }))
		.get('/throws-app-error', () => {
			throw new enums.AppError('CUSTOM_ERROR');
		})
		.get('/throws-plain-error', () => {
			throw new Error('unexpected');
		})
		.post('/validated', ({ body }) => body, {
			body: t.Object({ name: t.String() }),
		})
		.post('/validated-valibot', ({ body }) => body, {
			body: v.object({ email: v.string() }),
		});
}

describe('createApp', () => {
	test('a successful route passes through untouched', async () => {
		const app = createApp({ api: buildApi(), errors });
		const response = await app.handle(new Request('http://localhost/ok'));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, data: 'hi' });
	});

	test('an AppError is mapped to {ok:false, error:{code, message}} at its own status', async () => {
		const app = createApp({ api: buildApi(), errors });
		const response = await app.handle(
			new Request('http://localhost/throws-app-error'),
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			ok: false,
			error: { code: enums.codes.CUSTOM_ERROR, message: 'Custom error' },
		});
	});

	test('Elysia NOT_FOUND (unmatched route) is mapped to the caller-supplied spec', async () => {
		const app = createApp({ api: buildApi(), errors });
		const response = await app.handle(
			new Request('http://localhost/does-not-exist'),
		);
		expect(response.status).toBe(errors.NOT_FOUND.status);
		expect(await response.json()).toEqual({
			ok: false,
			error: { code: errors.NOT_FOUND.code, message: errors.NOT_FOUND.message },
		});
	});

	test('an unhandled plain Error is mapped to INTERNAL_ERROR — never leaked raw', async () => {
		const app = createApp({ api: buildApi(), errors });
		const response = await app.handle(
			new Request('http://localhost/throws-plain-error'),
		);
		expect(response.status).toBe(errors.INTERNAL_ERROR.status);
		const body = await response.json();
		expect(body).toEqual({
			ok: false,
			error: {
				code: errors.INTERNAL_ERROR.code,
				message: errors.INTERNAL_ERROR.message,
			},
		});
		expect(JSON.stringify(body)).not.toContain('unexpected');
	});

	test('every request runs inside its own request context (x-request-id set)', async () => {
		const app = createApp({ api: buildApi(), errors });
		const response = await app.handle(new Request('http://localhost/ok'));
		expect(response.headers.get('x-request-id')).toBeTruthy();
	});

	test('two concurrent requests get two distinct request ids', async () => {
		const app = createApp({ api: buildApi(), errors });
		const [a, b] = await Promise.all([
			app.handle(new Request('http://localhost/ok')),
			app.handle(new Request('http://localhost/ok')),
		]);
		expect(a.headers.get('x-request-id')).not.toBe(
			b.headers.get('x-request-id'),
		);
	});

	test('a request body validation failure is mapped to VALIDATION_FAILED', async () => {
		const app = createApp({ api: buildApi(), errors });
		const response = await app.handle(
			new Request('http://localhost/validated', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: 123 }),
			}),
		);
		expect(response.status).toBe(errors.VALIDATION_FAILED.status);
		expect(await response.json()).toEqual({
			ok: false,
			error: {
				code: errors.VALIDATION_FAILED.code,
				message: errors.VALIDATION_FAILED.message,
			},
		});
	});

	test('mounts openapi docs and converts a valibot route schema for the docs JSON', async () => {
		const app = createApp({ api: buildApi(), errors });
		const response = await app.handle(
			new Request('http://localhost/openapi/json'),
		);
		expect(response.status).toBe(200);

		// Exercises `mapJsonSchema.valibot` — the docs generator only calls it
		// when it actually meets a valibot schema among the mounted routes.
		const spec = await response.json();
		const body = JSON.stringify(spec);
		expect(body).toContain('/validated-valibot');
		expect(body).toContain('email');
	});
});
