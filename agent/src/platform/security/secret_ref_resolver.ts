import fs from 'node:fs';
import path from 'node:path';
import type { CredentialRef, CredentialResolver } from '../../security/credentials';
import { sha256Hex } from '../../security/digest';
import { SecurityError } from '../../security/errors';
import type { SecretRef } from '../config/secret_ref';
import { parseSecretRef, secretRefToRefString } from '../config/secret_ref';
import type {
    ResolvedSecret,
    SecretEnv,
    SecretFileStat,
    SecretFileSystem,
    SecretRefResolver,
    SecretResolutionErrorCode,
    SecretResolutionOptions,
} from './contracts';
import { SecretResolutionError } from './error';

const DEFAULT_MAX_BYTES = 16 * 1024;

export const envOf = (values: Readonly<Record<string, string | undefined>>): SecretEnv => ({
    get: (name) => values[name],
});

export const nodeFileSystem = (): SecretFileSystem => ({
    realpathSync: (filePath) => fs.realpathSync(filePath),
    statSync: (filePath) => fs.statSync(filePath),
    readFileSync: (filePath) => fs.readFileSync(filePath, 'utf8'),
});

const stripTerminalNewline = (raw: string): string => {
    if (!raw.endsWith('\n')) {return raw;}
    let body = raw.slice(0, -1);
    if (body.endsWith('\r')) {body = body.slice(0, -1);}
    return body;
};

const containedIn = (base: string, target: string): boolean => {
    const rel = path.relative(base, target);
    return rel !== ''
        && rel !== '..'
        && !rel.startsWith(`..${path.sep}`)
        && !path.isAbsolute(rel);
};

export const createSecretRefResolver = (options: SecretResolutionOptions): SecretRefResolver => {
    const env = options.env;
    const fileSystem = options.fs;
    const baseDir = path.resolve(options.baseDir);
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const requirePrivateFileMode = options.requirePrivateFileMode ?? false;
    const posix = process.platform !== 'win32';

    const describe = (ref: SecretRef): string =>
        ref.kind === 'env'
            ? `resolved from environment ${ref.envName}`
            : `resolved from file ${ref.filePath}`;

    const fail = (code: SecretResolutionErrorCode, refString: string, message: string): never => {
        throw new SecretResolutionError(code, refString, message);
    };

    const readOrFail = <T>(refString: string, code: SecretResolutionErrorCode, message: string, read: () => T): T => {
        try {
            return read();
        } catch {
            throw new SecretResolutionError(code, refString, message);
        }
    };

    const resolveFile = (ref: SecretRef & {kind: 'file'}): ResolvedSecret => {
        const refString = secretRefToRefString(ref);
        const baseCanonical = readOrFail(
            refString,
            'ERR_SECRET_FILE_NOT_FOUND',
            `secret base is unavailable: ${refString}`,
            () => fileSystem.realpathSync(baseDir),
        );
        const resolved = path.resolve(baseDir, ref.filePath);
        if (!containedIn(baseDir, resolved)) {
            fail('ERR_SECRET_FILE_ESCAPE', refString, `secret path escapes the trusted base: ${refString}`);
        }
        const canonical = readOrFail(
            refString,
            'ERR_SECRET_FILE_NOT_FOUND',
            `secret file not found: ${refString}`,
            () => fileSystem.realpathSync(resolved),
        );
        if (!containedIn(baseCanonical, canonical)) {
            fail('ERR_SECRET_FILE_ESCAPE', refString, `secret path escapes the trusted base: ${refString}`);
        }
        const stat = readOrFail(
            refString,
            'ERR_SECRET_FILE_NOT_FOUND',
            `secret file not found: ${refString}`,
            (): SecretFileStat => fileSystem.statSync(canonical),
        );
        if (!stat.isFile()) {
            fail('ERR_SECRET_FILE_NOT_REGULAR', refString, `secret is not a regular file: ${refString}`);
        }
        if (stat.size > maxBytes) {
            fail('ERR_SECRET_FILE_TOO_LARGE', refString, `secret file exceeds ${maxBytes} bytes: ${refString}`);
        }
        if (requirePrivateFileMode && posix && (stat.mode & 0o077) !== 0) {
            fail('ERR_SECRET_FILE_PERMISSIVE_MODE', refString, `secret file mode is too permissive: ${refString}`);
        }
        const raw = readOrFail(
            refString,
            'ERR_SECRET_FILE_NOT_FOUND',
            `secret file is unreadable: ${refString}`,
            () => fileSystem.readFileSync(canonical),
        );
        const value = stripTerminalNewline(raw);
        if (value.length === 0) {
            fail('ERR_SECRET_UNRESOLVABLE', refString, `resolved secret is empty: ${refString}`);
        }
        return { ref, refString, kind: 'file', value, digest: sha256Hex(value), source: describe(ref) };
    };

    const resolveCore = (ref: SecretRef): ResolvedSecret => {
        const refString = secretRefToRefString(ref);
        if (ref.kind === 'env') {
            const value = env.get(ref.envName);
            const secret = typeof value === 'string' && value.length > 0
                ? value
                : fail('ERR_SECRET_ENV_NOT_SET', refString, `environment secret is not set: ${refString}`);
            return { ref, refString, kind: 'env', value: secret, digest: sha256Hex(secret), source: describe(ref) };
        }
        return resolveFile(ref);
    };

    return {
        resolve: async (ref) => resolveCore(ref),
        has: (ref) => {
            try {
                resolveCore(ref);
                return true;
            } catch {
                return false;
            }
        },
        describe,
    };
};

export const credentialResolverFromSecretRefResolver = (resolver: SecretRefResolver): CredentialResolver => {
    const asSecretRef = (ref: CredentialRef): SecretRef | null => {
        try {
            return parseSecretRef(ref.id);
        } catch {
            return null;
        }
    };
    const notASecretReference = (): SecurityError =>
        new SecurityError('ERR_SECURITY_CREDENTIAL_UNRESOLVABLE', 'credential is not a secret reference');
    return {
        resolve: async (ref) => {
            const secretRef = asSecretRef(ref);
            if (secretRef === null) {throw notASecretReference();}
            try {
                return (await resolver.resolve(secretRef)).value;
            } catch (error) {
                if (error instanceof SecretResolutionError) {
                    const code = error.code === 'ERR_SECRET_ENV_NOT_SET' || error.code === 'ERR_SECRET_FILE_NOT_FOUND'
                        ? 'ERR_SECURITY_CREDENTIAL_NOT_FOUND'
                        : 'ERR_SECURITY_CREDENTIAL_UNRESOLVABLE';
                    throw new SecurityError(code, error.message);
                }
                throw notASecretReference();
            }
        },
        has: (ref) => {
            const secretRef = asSecretRef(ref);
            return secretRef !== null && resolver.has(secretRef);
        },
        describe: (ref) => {
            const secretRef = asSecretRef(ref);
            return secretRef === null ? `credential:${ref.id}` : resolver.describe(secretRef);
        },
    };
};