import { t } from '@rniverse/utils';
import Elysia from 'elysia';
import type { Auth } from '../../lib/auth.js';
export type AuthErrors = {
    /** No token. */
    unauthorized: () => Error;
    /** A bad, expired or blocked token. */
    invalid: () => Error;
};
export declare const schema$auth: {
    /** Required. */
    bearer: t.ObjectSchema<{
        readonly authorization: t.SchemaWithPipe<readonly [t.StringSchema<undefined>, t.StartsWithAction<string, "Bearer ", undefined>, t.TransformAction<string, string>]>;
    }, undefined>;
    /** Optional — absent is fine, but a present value must carry the Bearer scheme. */
    soft: t.ObjectSchema<{
        readonly authorization: t.OptionalSchema<t.SchemaWithPipe<readonly [t.StringSchema<undefined>, t.StartsWithAction<string, "Bearer ", undefined>, t.TransformAction<string, string>]>, undefined>;
    }, undefined>;
};
/**
 * `soft`: a token is optional; no token or a bad one gives `user: undefined`,
 * never throws. `base`: a valid token is required. `strict`: `base` plus the
 * verifier's `check` (e.g. a blocklist); it reuses `user` when `base` ran
 * first.
 */
export declare function auth<P extends {
    sub: string;
}>(verifier: Auth<P>, errors: AuthErrors): {
    soft: Elysia<"", {
        decorator: {};
        store: {};
        derive: {};
        resolve: {};
    }, {
        typebox: {};
        error: {};
    }, {
        schema: {};
        standaloneSchema: {};
        macro: {};
        macroFn: {};
        parser: {};
        response: {};
    }, {}, {
        derive: {};
        resolve: {
            readonly user: P | undefined;
        };
        schema: import("elysia").UnwrapRoute<{
            as: "scoped";
            headers: t.ObjectSchema<{
                readonly authorization: t.OptionalSchema<t.SchemaWithPipe<readonly [t.StringSchema<undefined>, t.StartsWithAction<string, "Bearer ", undefined>, t.TransformAction<string, string>]>, undefined>;
            }, undefined>;
        }, {}, "">;
        standaloneSchema: {};
        response: import("elysia").ExtractErrorFromHandle<{
            readonly user: P | undefined;
        }>;
    }, {
        derive: {};
        resolve: {};
        schema: {};
        standaloneSchema: {};
        response: {};
    }>;
    base: Elysia<"", {
        decorator: {};
        store: {};
        derive: {};
        resolve: {};
    }, {
        typebox: {};
        error: {};
    }, {
        schema: {};
        standaloneSchema: {};
        macro: {};
        macroFn: {};
        parser: {};
        response: {};
    }, {}, {
        derive: {};
        resolve: {
            readonly user: P;
        };
        schema: import("elysia").UnwrapRoute<{
            as: "scoped";
            headers: t.ObjectSchema<{
                readonly authorization: t.SchemaWithPipe<readonly [t.StringSchema<undefined>, t.StartsWithAction<string, "Bearer ", undefined>, t.TransformAction<string, string>]>;
            }, undefined>;
        }, {}, "">;
        standaloneSchema: {};
        response: import("elysia").ExtractErrorFromHandle<{
            readonly user: P;
        }>;
    }, {
        derive: {};
        resolve: {};
        schema: {};
        standaloneSchema: {};
        response: {};
    }>;
    readonly strict: Elysia<"", {
        decorator: {};
        store: {};
        derive: {};
        resolve: {};
    }, {
        typebox: {};
        error: {};
    }, {
        schema: {};
        standaloneSchema: {};
        macro: {};
        macroFn: {};
        parser: {};
        response: {};
    }, {}, {
        derive: {};
        resolve: {
            readonly user: P;
        };
        schema: import("elysia").UnwrapRoute<{
            as: "scoped";
            headers: t.ObjectSchema<{
                readonly authorization: t.SchemaWithPipe<readonly [t.StringSchema<undefined>, t.StartsWithAction<string, "Bearer ", undefined>, t.TransformAction<string, string>]>;
            }, undefined>;
        }, {}, "">;
        standaloneSchema: {};
        response: import("elysia").ExtractErrorFromHandle<{
            readonly user: P;
        }>;
    }, {
        derive: {};
        resolve: {};
        schema: {};
        standaloneSchema: {};
        response: {};
    }>;
};
//# sourceMappingURL=auth.middleware.d.ts.map