import type { Result } from '@rniverse/utils/result';
export type KeySource = 
/** PEM public key (SPKI). */
{
    key: string;
}
/** URL of the issuer's JWKS, e.g. `${AUTH_SERVICE_URL}/.well-known/jwks.json`. */
 | {
    jwks: string;
};
export type AuthFailure = 'missing' | 'invalid' | 'blocked';
export type AuthOptions<P> = {
    source: KeySource;
    /** Expected `iss`. */
    issuer: string;
    /** Strict verification only: resolve `true` when the token is blocked. */
    check?: (payload: P) => Promise<boolean>;
};
export declare function createAuth<P extends {
    sub: string;
}>(options: AuthOptions<P>): {
    /** Whether strict verification is possible (a `check` was given). */
    strict: boolean;
    /** `'Bearer x'` → `'x'`; anything else → `undefined`. */
    bearer(header?: string | null): string | undefined;
    /**
     * Signature, expiry and issuer — and, when `strict`, the `check`. Pass
     * `user` instead of `token` to run only the strict check on an
     * already-verified payload.
     */
    verify(input: {
        token?: string;
        user?: P;
        strict?: boolean;
    }): Promise<Result<P, AuthFailure>>;
};
export type Auth<P extends {
    sub: string;
} = {
    sub: string;
}> = ReturnType<typeof createAuth<P>>;
//# sourceMappingURL=auth.d.ts.map