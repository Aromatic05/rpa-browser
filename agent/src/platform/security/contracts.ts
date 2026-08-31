import type {SecretRef} from '../config/secret_ref';
import type {SecretValue} from '../../security/credentials';

export type SecretRefKind = SecretRef['kind'];

export type SecretEnv = Readonly<{
    get: (name: string) => string | undefined;
}>;

export type SecretFileStat = Readonly<{
    size: number;
    mode: number;
    isFile: () => boolean;
    isDirectory: () => boolean;
    isSymbolicLink: () => boolean;
}>;

export type SecretFileSystem = Readonly<{
    realpathSync: (filePath: string) => string;
    statSync: (filePath: string) => SecretFileStat;
    readFileSync: (filePath: string) => string;
}>;

export type SecretResolutionErrorCode =
    | 'ERR_SECRET_ENV_NOT_SET'
    | 'ERR_SECRET_FILE_NOT_FOUND'
    | 'ERR_SECRET_FILE_NOT_REGULAR'
    | 'ERR_SECRET_FILE_TOO_LARGE'
    | 'ERR_SECRET_FILE_PERMISSIVE_MODE'
    | 'ERR_SECRET_FILE_ESCAPE'
    | 'ERR_SECRET_UNRESOLVABLE';

export type SecretResolutionOptions = Readonly<{
    env: SecretEnv;
    fs: SecretFileSystem;
    baseDir: string;
    maxBytes?: number;
    requirePrivateFileMode?: boolean;
}>;

export type ResolvedSecret = Readonly<{
    ref: SecretRef;
    refString: string;
    kind: SecretRefKind;
    value: SecretValue;
    digest: string;
    source: string;
}>;

export type SecretRefResolver = Readonly<{
    resolve: (ref: SecretRef) => Promise<ResolvedSecret>;
    has: (ref: SecretRef) => boolean;
    describe: (ref: SecretRef) => string;
}>;