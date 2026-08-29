import type {CredentialResolver} from '../../../security/credentials';
import {parseCredentialRef, serializeCredentialRef} from '../../../security/credentials';

export const isCredentialRefString = (value: unknown): value is string => {
    if (typeof value !== 'string') {return false;}
    let parsed: ReturnType<typeof parseCredentialRef>;
    try {
        parsed = parseCredentialRef(value);
    } catch {
        return false;
    }
    return serializeCredentialRef(parsed) === value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const rewriteValue = async (
    value: unknown,
    resolve: CredentialResolver['resolve'],
): Promise<unknown> => {
    if (isCredentialRefString(value)) {
        return await resolve(parseCredentialRef(value));
    }
    if (Array.isArray(value)) {
        const rewritten: unknown[] = new Array<unknown>(value.length);
        for (let index = 0; index < value.length; index += 1) {
            rewritten[index] = await rewriteValue(value[index], resolve);
        }
        return rewritten;
    }
    if (isRecord(value)) {
        const rewritten: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value)) {
            rewritten[key] = await rewriteValue(child, resolve);
        }
        return rewritten;
    }
    return value;
};

export const materializeCredentialInput = async (
    input: Readonly<Record<string, unknown>>,
    resolver: CredentialResolver,
): Promise<Record<string, unknown>> => {
    const materialized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
        materialized[key] = await rewriteValue(value, resolver.resolve);
    }
    return materialized;
};