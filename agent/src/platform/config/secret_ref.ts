/**
 * 密钥引用（SecretRef）编解码。
 *
 * 配置中只允许存放「指向密钥来源的引用」，绝不存放明文密钥值。
 * 序列化形式：env:VAR_NAME 或 file:PATH。
 */

export type SecretRef =
    | Readonly<{kind: 'env'; envName: string}>
    | Readonly<{kind: 'file'; filePath: string}>;

const REF_ENV_PREFIX = 'env:';
const REF_FILE_PREFIX = 'file:';

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const secretRefToRefString = (ref: SecretRef): string =>
    ref.kind === 'env' ? `${REF_ENV_PREFIX}${ref.envName}` : `${REF_FILE_PREFIX}${ref.filePath}`;

export const parseSecretRef = (raw: string, field = 'secretRef'): SecretRef => {
    if (typeof raw !== 'string' || raw.length === 0) {
        throw new Error(
            `${field} must be a non-empty reference string ('env:VAR_NAME' or 'file:PATH'), got ${JSON.stringify(raw)}`,
        );
    }
    if (raw.startsWith(REF_ENV_PREFIX)) {
        const envName = raw.slice(REF_ENV_PREFIX.length);
        if (!ENV_NAME_PATTERN.test(envName)) {
            throw new Error(
                `${field} env reference must name a safe environment variable, got ${JSON.stringify(raw)}`,
            );
        }
        return {kind: 'env', envName};
    }
    if (raw.startsWith(REF_FILE_PREFIX)) {
        const filePath = raw.slice(REF_FILE_PREFIX.length);
        if (filePath.length === 0 || filePath.includes('\u0000')) {
            throw new Error(
                `${field} file reference must name a non-empty path without NUL bytes, got ${JSON.stringify(raw)}`,
            );
        }
        return {kind: 'file', filePath};
    }
    throw new Error(
        `${field} must start with 'env:' or 'file:', got ${JSON.stringify(raw)}`,
    );
};