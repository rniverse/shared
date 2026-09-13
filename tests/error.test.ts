import { describe, expect, test } from 'bun:test';
import { createErrorEnum, reasonOf } from '@lib/error';

const LIST = [
	['NOT_FOUND', 'Not found', 404],
	['VALIDATION_FAILED', 'Validation failed', 422],
	['INTERNAL_ERROR', 'Internal error', 500],
] as const;

describe('createErrorEnum', () => {
	test('key maps every list entry to its own name', () => {
		const enums = createErrorEnum(LIST);
		expect(enums.key.NOT_FOUND).toBe('NOT_FOUND');
		expect(enums.key.VALIDATION_FAILED).toBe('VALIDATION_FAILED');
		expect(enums.key.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
	});

	test('messages/status are looked up by key', () => {
		const enums = createErrorEnum(LIST);
		expect(enums.messages.NOT_FOUND).toBe('Not found');
		expect(enums.status.NOT_FOUND).toBe(404);
		expect(enums.messages.VALIDATION_FAILED).toBe('Validation failed');
		expect(enums.status.VALIDATION_FAILED).toBe(422);
	});

	test('codes are sequential, fixed-length, and unique per key', () => {
		const enums = createErrorEnum(LIST);
		expect(enums.codes.NOT_FOUND).toBe('0000000001');
		expect(enums.codes.VALIDATION_FAILED).toBe('0000000002');
		expect(enums.codes.INTERNAL_ERROR).toBe('0000000003');
	});

	test('two independent createErrorEnum() calls get independent sequences', () => {
		const first = createErrorEnum(LIST);
		const second = createErrorEnum(LIST);
		// Both start over at 1 — no shared module-level counter (§3 of spec.md).
		expect(first.codes.NOT_FOUND).toBe('0000000001');
		expect(second.codes.NOT_FOUND).toBe('0000000001');
	});

	test('spec() returns the {code, message, status} triple for one key', () => {
		const enums = createErrorEnum(LIST);
		expect(enums.spec('NOT_FOUND')).toEqual({
			code: '0000000001',
			message: 'Not found',
			status: 404,
		});
	});

	describe('AppError', () => {
		test('carries key, code, message, and status_code from the list', () => {
			const enums = createErrorEnum(LIST);
			const err = new enums.AppError('VALIDATION_FAILED');
			expect(err).toBeInstanceOf(Error);
			expect(err.name).toBe('AppError');
			expect(err.key).toBe('VALIDATION_FAILED');
			expect(err.code).toBe(enums.codes.VALIDATION_FAILED);
			expect(err.message).toBe('Validation failed');
			expect(err.status_code).toBe(422);
		});

		test('status_code falls back to 400 when the list has no status', () => {
			const enums = createErrorEnum([
				['NO_STATUS', 'No status given', undefined as unknown as number],
			] as const);
			const err = new enums.AppError('NO_STATUS');
			expect(err.status_code).toBe(400);
		});

		test('details.status_code overrides the list-declared status', () => {
			const enums = createErrorEnum(LIST);
			const err = new enums.AppError('NOT_FOUND', { status_code: 410 });
			expect(err.status_code).toBe(410);
			expect(err.details).toEqual({ status_code: 410 });
		});

		test('two AppError classes from different createErrorEnum() calls are distinct', () => {
			const first = createErrorEnum(LIST);
			const second = createErrorEnum(LIST);
			const err = new first.AppError('NOT_FOUND');
			expect(err).toBeInstanceOf(first.AppError);
			expect(err).not.toBeInstanceOf(second.AppError);
		});
	});
});

describe('reasonOf', () => {
	test('returns the message of an Error', () => {
		expect(reasonOf(new Error('boom'))).toBe('boom');
	});

	test('stringifies a non-Error value', () => {
		expect(reasonOf('plain string')).toBe('plain string');
		expect(reasonOf(42)).toBe('42');
		expect(reasonOf({ some: 'object' })).toBe('[object Object]');
	});
});
