import {REDACTED_SECRET_PLACEHOLDER} from '../../security/redaction';

export {REDACTED_SECRET_PLACEHOLDER};

const SECRET_KEY_TOKENS = '(?:api[_-]?key|access[_-]?key|auth(?:orization)?|cert(?:ificate)?|cookie|credential|csrf|otp|passw(?:or)?d|passphrase|private[_-]?key|secret|session|signature|token)';
const SECRET_KEY_PATTERN = new RegExp(`^(?:.*[_\\-.])?${SECRET_KEY_TOKENS}(?:[_\\-.].*)?$`, 'iu');

export type AgentReportRedaction = Readonly<{
    value: unknown;
    redactedPaths: readonly string[];
}>;

const normalizeKey = (key: string): string => key
    .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .toLowerCase();

const isSecretKey = (key: string): boolean => SECRET_KEY_PATTERN.test(normalizeKey(key));

const redact = (value: unknown, path: string, paths: string[]): unknown => {
    if (Array.isArray(value)) {
        return value.map((item, index) => redact(item, `${path}[${index}]`, paths));
    }
    if (value !== null && typeof value === 'object') {
        const next: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            const entryPath = path === '' ? key : `${path}.${key}`;
            if (isSecretKey(key)) {
                next[key] = REDACTED_SECRET_PLACEHOLDER;
                paths.push(entryPath);
                continue;
            }
            next[key] = redact(entry, entryPath, paths);
        }
        return next;
    }
    return value;
};

export const redactSecretValues = (value: unknown): AgentReportRedaction => {
    const paths: string[] = [];
    return Object.freeze({
        value: redact(value, '', paths),
        redactedPaths: Object.freeze([...new Set(paths)].sort()),
    });
};
