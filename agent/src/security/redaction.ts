export const REDACTED_SECRET_PLACEHOLDER = '[redacted]';

export type RedactionResult = Readonly<{
    value: unknown;
    redactedPaths: readonly string[];
}>;

export type RedactionOptions = Readonly<{
    secrets?: Iterable<string>;
    secretKeys?: Iterable<string>;
    maskUrlQuery?: boolean;
    maskUrlFragment?: boolean;
    maxDepth?: number;
    maxStringLength?: number;
    maxArrayItems?: number;
    maxObjectKeys?: number;
    placeholder?: string;
}>;

export type RedactionPolicy = Readonly<{
    redact: (value: unknown) => RedactionResult;
    redactString: (value: string) => RedactionResult;
    registeredSecrets: () => readonly string[];
    isSensitiveKey: (key: string) => boolean;
    maxDepth: number;
    maxStringLength: number;
    maxArrayItems: number;
    maxObjectKeys: number;
}>;

const MAX_DEPTH_MARKER = '[max-depth]';
const TRUNCATED_MARKER = '[truncated]';
const TRUNCATED_KEYS_MARKER = '[truncated]';

const normalizeKeyToken = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/gu, '');

const DEFAULT_SECRET_KEY_TOKENS: readonly string[] = Object.freeze([
    'apiKey',
    'clientSecret',
    'accessToken',
    'refreshToken',
    'auth',
    'authorization',
    'certificate',
    'cookie',
    'credential',
    'credentials',
    'csrf',
    'otp',
    'passphrase',
    'password',
    'passwd',
    'privateKey',
    'pwd',
    'secret',
    'secrets',
    'session',
    'sid',
    'signature',
    'token',
]);

const assertNonNegativeInteger = (value: number, name: string): void => {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative integer, got ${value}`);
    }
};

const MAX_DEPTH_DEFAULT = 16;
const MAX_STRING_LENGTH_DEFAULT = 2048;
const MAX_ARRAY_ITEMS_DEFAULT = 256;
const MAX_OBJECT_KEYS_DEFAULT = 256;

const joinPath = (path: string, key: string): string => (path === '' ? key : `${path}.${key}`);

export const createRedactionPolicy = (options: RedactionOptions = {}): RedactionPolicy => {
    const placeholder = options.placeholder ?? REDACTED_SECRET_PLACEHOLDER;
    const maxDepth = options.maxDepth ?? MAX_DEPTH_DEFAULT;
    const maxStringLength = options.maxStringLength ?? MAX_STRING_LENGTH_DEFAULT;
    const maxArrayItems = options.maxArrayItems ?? MAX_ARRAY_ITEMS_DEFAULT;
    const maxObjectKeys = options.maxObjectKeys ?? MAX_OBJECT_KEYS_DEFAULT;
    const maskUrlQuery = options.maskUrlQuery ?? true;
    const maskUrlFragment = options.maskUrlFragment ?? true;

    assertNonNegativeInteger(maxDepth, 'maxDepth');
    assertNonNegativeInteger(maxStringLength, 'maxStringLength');
    assertNonNegativeInteger(maxArrayItems, 'maxArrayItems');
    assertNonNegativeInteger(maxObjectKeys, 'maxObjectKeys');

    const providedSecrets = [...(options.secrets ?? [])].filter((secret) => secret.length > 0);
    const secrets = [...new Set<string>(providedSecrets)].sort(
        (a, b) => b.length - a.length || (a < b ? -1 : 1),
    );

    const providedSecretKeyTokens = new Set<string>(
        [...(options.secretKeys ?? [])].map(normalizeKeyToken).filter((token) => token.length > 0),
    );
    const secretKeyTokens = new Set<string>([
        ...providedSecretKeyTokens,
        ...DEFAULT_SECRET_KEY_TOKENS.map(normalizeKeyToken),
    ]);

    const isSensitiveKey = (key: string): boolean => {
        const segments = key.toLowerCase().split(/[-_\s.]+/u).filter((segment) => segment.length > 0);
        for (let index = 0; index < segments.length; index += 1) {
            const single = segments[index];
            if (single && secretKeyTokens.has(single)) {return true;}
            const joined = segments.slice(index, index + 2).join('');
            if (joined && secretKeyTokens.has(joined)) {return true;}
        }
        return false;
    };

    const maskExactOrContained = (value: string): string => {
        let out = value;
        for (const secret of secrets) {
            if (out === secret) {
                return placeholder;
            }
            if (out.indexOf(secret) !== -1) {
                out = out.split(secret).join(placeholder);
            }
        }
        return out;
    };

    const maskUrlString = (value: string): string | null => {
        let url: URL;
        try {
            url = new URL(value);
        } catch {
            return null;
        }
        if (url.username !== '') {url.username = placeholder;}
        if (url.password !== '') {url.password = placeholder;}
        if (maskUrlQuery) {
            const params = url.searchParams;
            for (const [key, entry] of [...params]) {
                if (isSensitiveKey(key)) {
                    params.set(key, placeholder);
                    continue;
                }
                const masked = maskExactOrContained(entry);
                if (masked !== entry) {
                    params.set(key, masked);
                }
            }
        }
        if (maskUrlFragment && url.hash.length > 1) {
            const fragment = url.hash.slice(1);
            const masked = maskExactOrContained(fragment);
            if (masked !== fragment) {
                url.hash = masked;
            }
        }
        return url.toString();
    };

    const maskString = (value: string): string => {
        let out = value;
        const urlMasked = maskUrlString(out);
        if (urlMasked !== null) {
            out = urlMasked;
        }
        return maskExactOrContained(out);
    };

    const truncateString = (value: string): string => {
        if (value.length <= maxStringLength) {return value;}
        const prefix = value.slice(0, maxStringLength);
        return `${prefix}${TRUNCATED_MARKER}`;
    };

    type RedactState = {paths: string[]};

    const redactValue = (value: unknown, path: string, depth: number, state: RedactState): unknown => {
        if (depth > maxDepth) {
            state.paths.push(path);
            return MAX_DEPTH_MARKER;
        }
        if (typeof value === 'string') {
            let out = maskString(value);
            let changed = out !== value;
            if (out.length > maxStringLength) {
                out = truncateString(out);
                changed = true;
            }
            if (changed) {
                state.paths.push(path);
            }
            return out;
        }
        if (typeof value === 'number') {
            return Number.isFinite(value) ? value : String(value);
        }
        if (typeof value === 'bigint') {
            return value.toString();
        }
        if (typeof value === 'undefined' || value === null || typeof value === 'boolean') {
            return value;
        }
        if (typeof value === 'function') {
            return `[function ${value.name || 'anonymous'}]`;
        }
        if (typeof value === 'symbol') {
            return value.description === undefined ? '[symbol]' : `[symbol ${value.description}]`;
        }
        if (value instanceof Error) {
            const stack = value.stack ?? `${value.name ? value.name : 'Error'}: ${value.message}`;
            const out: Record<string, unknown> = {
                name: redactValue(value.name, joinPath(path, 'name'), depth + 1, state),
                message: redactValue(value.message, joinPath(path, 'message'), depth + 1, state),
                stack: redactValue(stack, joinPath(path, 'stack'), depth + 1, state),
            };
            for (const [key, entry] of Object.entries(value as unknown as Record<string, unknown>)) {
                out[key] = redactValue(entry, joinPath(path, key), depth + 1, state);
            }
            if (value.cause !== undefined) {
                out.cause = redactValue(value.cause, joinPath(path, 'cause'), depth + 1, state);
            }
            return out;
        }
        if (value instanceof Date) {
            return value.toISOString();
        }
        if (Array.isArray(value)) {
            const out: unknown[] = [];
            let truncated = false;
            for (let index = 0; index < value.length; index += 1) {
                if (index >= maxArrayItems) {
                    truncated = true;
                    break;
                }
                out.push(redactValue(value[index], `${path}[${index}]`, depth + 1, state));
            }
            if (truncated) {
                out.push(TRUNCATED_MARKER);
                state.paths.push(path);
            }
            return out;
        }
        const record = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        let truncated = false;
        let index = 0;
        for (const [key, entry] of Object.entries(record)) {
            if (index >= maxObjectKeys) {
                truncated = true;
                break;
            }
            index += 1;
            if (isSensitiveKey(key)) {
                out[key] = placeholder;
                state.paths.push(joinPath(path, key));
                continue;
            }
            out[key] = redactValue(entry, joinPath(path, key), depth + 1, state);
        }
        if (truncated) {
            out[TRUNCATED_KEYS_MARKER] = TRUNCATED_MARKER;
            state.paths.push(path);
        }
        return out;
    };

    const finish = (value: unknown, paths: string[]): RedactionResult =>
        Object.freeze({
            value,
            redactedPaths: Object.freeze([...new Set(paths)].sort()),
        });

    return Object.freeze({
        redact: (value) => {
            const state: RedactState = {paths: []};
            return finish(redactValue(value, '', 0, state), state.paths);
        },
        redactString: (value) => {
            const state: RedactState = {paths: []};
            const out = redactValue(value, '', 0, state);
            const paths = state.paths.length > 0 ? ['value'] : [];
            return finish(out, paths);
        },
        registeredSecrets: () => Object.freeze([...secrets]),
        isSensitiveKey,
        maxDepth,
        maxStringLength,
        maxArrayItems,
        maxObjectKeys,
    });
};