export type ErrorEntry = readonly [
    key: string,
    message: string,
    status: number
];
export type ErrorSpec = {
    code: string;
    message: string;
    status: number;
};
export declare function createErrorEnum<const L extends readonly ErrorEntry[]>(list: L): {
    key: Record<L[number][0], L[number][0]>;
    messages: Record<L[number][0], string>;
    codes: Record<L[number][0], string>;
    status: Record<L[number][0], number>;
    spec: (errorKey: L[number][0]) => ErrorSpec;
    AppError: {
        new (errorKey: L[number][0], details?: Record<string, unknown>): {
            key: L[number][0];
            code: string;
            status_code: number;
            details?: Record<string, unknown>;
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        };
        prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
        isError(error: unknown): error is Error;
        isError(value: unknown): value is Error;
        captureStackTrace(targetObject: object, constructorOpt?: Function): void;
        captureStackTrace(targetObject: object, constructorOpt?: Function): void;
        stackTraceLimit: number;
    };
};
export declare function reasonOf(error: unknown): string;
//# sourceMappingURL=error.d.ts.map