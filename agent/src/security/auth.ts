import type {Principal} from './context';
import {isPrincipal} from './context';
import {sha256Hex} from './digest';
import {isCapability, type Capability} from './capabilities';

export const bearerTokenDigest = (token: string): string => `sha256:${sha256Hex(token)}`;

export type BearerTokenParseFailureCode = 'missing' | 'unsupported-scheme' | 'malformed';

export type BearerToken =
    | Readonly<{ok: true; token: string}>
    | Readonly<{ok: false; code: BearerTokenParseFailureCode; message: string}>;

export type BearerAuthFailureCode =
    | BearerTokenParseFailureCode
    | 'invalid-credential'
    | 'verification-failed';

export type BearerAuthResult =
    | Readonly<{
        ok: true;
        principal: Principal;
        scopes: ReadonlySet<string>;
        capabilities: ReadonlySet<Capability>;
        tokenDigest: string;
    }>
    | Readonly<{ok: false; code: BearerAuthFailureCode; message: string}>;

export type BearerTokenVerifier = Readonly<{
    verify: (token: string) => Promise<Principal | null>;
}>;

export type BearerAuthenticator = Readonly<{
    authenticate: (authorization: string | null | undefined) => Promise<BearerAuthResult>;
}>;

// Constant messages: an authentication failure must never echo the input, so a
// token cannot leak through an error message.
const MESSAGE_MISSING = 'authorization header is required';
const MESSAGE_SCHEME = 'unsupported authorization scheme';
const MESSAGE_MALFORMED = 'malformed bearer token';
const MESSAGE_INVALID = 'invalid bearer token';
const MESSAGE_VERIFY_FAILED = 'credential verification failed';

const AUTHORIZATION_PATTERN = /^([A-Za-z]+) ([^ ]+)$/;

// RFC 6750 b64token: alphanumerics, '.', '-', '_', '~', '+' and '/' with
// optional trailing '=' padding.
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]+$/;

export const parseBearerToken = (authorization: string | null | undefined): BearerToken => {
    if (typeof authorization !== 'string' || authorization.length === 0) {
        return {ok: false, code: 'missing', message: MESSAGE_MISSING};
    }
    const trimmed = authorization.trim();
    if (trimmed.length === 0) {
        return {ok: false, code: 'missing', message: MESSAGE_MISSING};
    }
    const match = AUTHORIZATION_PATTERN.exec(trimmed);
    if (match === null) {
        return {ok: false, code: 'malformed', message: MESSAGE_MALFORMED};
    }
    const scheme = match[1];
    const token = match[2];
    if (scheme.toLowerCase() !== 'bearer') {
        return {ok: false, code: 'unsupported-scheme', message: MESSAGE_SCHEME};
    }
    if (!TOKEN_PATTERN.test(token)) {
        return {ok: false, code: 'malformed', message: MESSAGE_MALFORMED};
    }
    return {ok: true, token};
};

const scopesOf = (principal: Principal): ReadonlySet<string> =>
    Object.freeze(new Set<string>(principal.scopes ?? []));

const capabilitiesOf = (principal: Principal): ReadonlySet<Capability> => {
    const capabilities = new Set<Capability>();
    for (const scope of principal.scopes ?? []) {
        for (const entry of scope.split(' ')) {
            if (isCapability(entry)) {
                capabilities.add(entry);
            }
        }
    }
    return Object.freeze(new Set<Capability>(capabilities));
};

export const createBearerAuthenticator = (deps: BearerTokenVerifier): BearerAuthenticator => ({
    async authenticate(authorization) {
        const parsed = parseBearerToken(authorization);
        if (!parsed.ok) {
            return {ok: false, code: parsed.code, message: parsed.message};
        }
        let principal: Principal | null;
        try {
            principal = await deps.verify(parsed.token);
        } catch {
            return {ok: false, code: 'verification-failed', message: MESSAGE_VERIFY_FAILED};
        }
        if (!isPrincipal(principal)) {
            return {ok: false, code: 'invalid-credential', message: MESSAGE_INVALID};
        }
        return {
            ok: true,
            principal,
            scopes: scopesOf(principal),
            capabilities: capabilitiesOf(principal),
            tokenDigest: bearerTokenDigest(parsed.token),
        };
    },
});