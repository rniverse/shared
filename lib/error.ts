import { sync$seq } from '@rniverse/utils';

// Generalizes the `[key, message, status]` list + AppError pattern every
// service was hand-rolling identically (only the `list` content ever
// differed). Each repo keeps its own list local — this only owns the
// mechanism: sequential numeric codes, message/status lookup, and an
// AppError class bound to that specific list.
export type ErrorEntry = readonly [
	key: string,
	message: string,
	status: number,
];

export type ErrorSpec = { code: string; message: string; status: number };

export function createErrorEnum<const L extends readonly ErrorEntry[]>(
	list: L,
) {
	type ErrorKey = L[number][0];

	const messages = Object.fromEntries(
		list.map(([k, msg]) => [k, msg]),
	) as Record<ErrorKey, string>;
	const status = Object.fromEntries(list.map(([k, , s]) => [k, s])) as Record<
		ErrorKey,
		number
	>;
	const get_next_code = sync$seq.get({ type: 'code', length: 10, radix: 10 });
	const codes = Object.fromEntries(
		list.map(([k]) => [k, get_next_code()]),
	) as Record<ErrorKey, string>;
	const key = Object.keys(messages).reduce(
		(acc, k) => {
			acc[k as ErrorKey] = k as ErrorKey;
			return acc;
		},
		{} as Record<ErrorKey, ErrorKey>,
	);

	/** The `{code, message, status}` triple `createApp()`'s onError needs for one key. */
	function spec(errorKey: ErrorKey): ErrorSpec {
		return {
			code: codes[errorKey],
			message: messages[errorKey],
			status: status[errorKey],
		};
	}

	class AppError extends Error {
		key: ErrorKey;
		code: string;
		status_code: number;
		details?: Record<string, unknown>;

		constructor(errorKey: ErrorKey, details?: Record<string, unknown>) {
			super(messages[errorKey]);
			this.name = 'AppError';
			this.key = errorKey;
			this.code = codes[errorKey];
			this.status_code =
				(details?.status_code as number) ?? status[errorKey] ?? 400;
			this.details = details;
		}
	}

	return { key, messages, codes, status, spec, AppError };
}

export function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
