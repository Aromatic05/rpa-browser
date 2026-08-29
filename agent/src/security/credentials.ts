import {SecurityError} from './errors';

export type SecretValue = string;

export type CredentialKind = 'credential' | 'api-key' | 'token' | 'secret' | 'password' | 'cookie';

export type CredentialRef = Readonly<{
    id: string;
    kind: CredentialKind;
    provider?: string;
    hint?: string;
}>;

export type CredentialResolver = Readonly<{
    resolve: (ref: CredentialRef) => Promise<SecretValue>;
    has: (ref: CredentialRef) => boolean;
    describe: (ref: CredentialRef) => string;
}>;

const CREDENTIAL_KINDS: ReadonlySet<string> = new Set<string>([
    'credential',
    'api-key',
    'token',
    'secret',
    'password',
    'cookie',
]);

const parseCredentialKind = (value: string | undefined): CredentialKind => {
    if (value === undefined) {return 'credential';}
    if (!CREDENTIAL_KINDS.has(value)) {
        throw new SecurityError('ERR_SECURITY_BAD_CREDENTIAL_REF', `unknown credential kind: ${value}`);
    }
    return value as CredentialKind;
};

export const createCredentialRef = (options: Readonly<{id: string; kind?: string; provider?: string; hint?: string}>): CredentialRef => {
    const id = options.id.trim();
    if (!id) {
        throw new SecurityError('ERR_SECURITY_BAD_CREDENTIAL_REF', 'credential ref id must be a non-empty string');
    }
    const provider = options.provider === undefined ? undefined : options.provider.trim();
    if (provider !== undefined && !provider) {
        throw new SecurityError('ERR_SECURITY_BAD_CREDENTIAL_REF', 'credential ref provider must be a non-empty string');
    }
    const hint = options.hint === undefined ? undefined : options.hint.trim();
    if (hint !== undefined && !hint) {
        throw new SecurityError('ERR_SECURITY_BAD_CREDENTIAL_REF', 'credential ref hint must be a non-empty string');
    }
    const ref: CredentialRef = {
        id,
        kind: parseCredentialKind(options.kind),
        ...(provider !== undefined ? {provider} : {}),
        ...(hint !== undefined ? {hint} : {}),
    };
    return Object.freeze(ref);
};

export const serializeCredentialRef = (ref: CredentialRef): string => JSON.stringify(ref);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export const parseCredentialRef = (text: string): CredentialRef => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text) as unknown;
    } catch {
        throw new SecurityError('ERR_SECURITY_BAD_CREDENTIAL_REF', 'credential ref must be valid json');
    }
    if (!isRecord(parsed) || typeof parsed.id !== 'string') {
        throw new SecurityError('ERR_SECURITY_BAD_CREDENTIAL_REF', 'credential ref must be an object with a string id');
    }
    const unknownKeys = Object.keys(parsed).filter((key) => key !== 'id' && key !== 'kind' && key !== 'provider' && key !== 'hint');
    if (unknownKeys.length > 0) {
        throw new SecurityError('ERR_SECURITY_BAD_CREDENTIAL_REF', `credential ref contains unsupported fields: ${unknownKeys.join(', ')}`);
    }
    return createCredentialRef({
        id: parsed.id,
        ...(typeof parsed.kind === 'string' ? {kind: parsed.kind} : {}),
        ...(typeof parsed.provider === 'string' ? {provider: parsed.provider} : {}),
        ...(typeof parsed.hint === 'string' ? {hint: parsed.hint} : {}),
    });
};

export const credentialRefForEnv = (envName: string): CredentialRef =>
    createCredentialRef({
        id: `env:${envName}`,
        kind: 'credential',
        provider: 'env',
        hint: `resolved from environment ${envName}`,
    });

export const createMemoryCredentialResolver = (entries: Readonly<Record<string, string>>): CredentialResolver => {
    const store = new Map<string, string>(Object.entries(entries).map(([id, value]) => [id, value]));
    return {
        resolve: async (ref) => {
            const value = store.get(ref.id);
            if (value === undefined) {
                throw new SecurityError('ERR_SECURITY_CREDENTIAL_NOT_FOUND', `credential not found: ${ref.id}`);
            }
            return value;
        },
        has: (ref) => store.has(ref.id),
        describe: (ref) => (ref.hint && ref.hint.length > 0 ? ref.hint : `credential:${ref.id}`),
    };
};

export const createEnvCredentialResolver = (env: Readonly<Record<string, string | undefined>>): CredentialResolver => {
    const valueOf = (ref: CredentialRef): string | undefined => {
        if (!ref.id.startsWith('env:')) {return undefined;}
        return env[ref.id.slice('env:'.length)];
    };
    return {
        resolve: async (ref) => {
            const value = valueOf(ref);
            if (typeof value !== 'string' || value.length === 0) {
                throw new SecurityError('ERR_SECURITY_CREDENTIAL_NOT_FOUND', `environment credential not found: ${ref.id}`);
            }
            return value;
        },
        has: (ref) => {
            const value = valueOf(ref);
            return typeof value === 'string' && value.length > 0;
        },
        describe: (ref) => (ref.hint && ref.hint.length > 0 ? ref.hint : `credential:${ref.id}`),
    };
};

export const createDenyAllCredentialResolver = (): CredentialResolver => ({
    resolve: async (ref) => {
        throw new SecurityError('ERR_SECURITY_CREDENTIAL_UNRESOLVABLE', `credential resolution is denied: ${ref.id}`);
    },
    has: () => false,
    describe: (ref) => (ref.hint && ref.hint.length > 0 ? ref.hint : `credential:${ref.id}`),
});