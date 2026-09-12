import { sync$seq } from '@rniverse/utils';
export function createErrorEnum(list) {
    const messages = Object.fromEntries(list.map(([k, msg]) => [k, msg]));
    const status = Object.fromEntries(list.map(([k, , s]) => [k, s]));
    const get_next_code = sync$seq.get({ type: 'code', length: 10, radix: 10 });
    const codes = Object.fromEntries(list.map(([k]) => [k, get_next_code()]));
    const key = Object.keys(messages).reduce((acc, k) => {
        acc[k] = k;
        return acc;
    }, {});
    /** The `{code, message, status}` triple `createApp()`'s onError needs for one key. */
    function spec(errorKey) {
        return {
            code: codes[errorKey],
            message: messages[errorKey],
            status: status[errorKey],
        };
    }
    class AppError extends Error {
        key;
        code;
        status_code;
        details;
        constructor(errorKey, details) {
            super(messages[errorKey]);
            this.name = 'AppError';
            this.key = errorKey;
            this.code = codes[errorKey];
            this.status_code =
                details?.status_code ?? status[errorKey] ?? 400;
            this.details = details;
        }
    }
    return { key, messages, codes, status, spec, AppError };
}
export function reasonOf(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=error.js.map