import type {CredentialRef, CredentialResolver} from '../../../../security/credentials';
import {parseCredentialRef, serializeCredentialRef} from '../../../../security/credentials';

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

export const collectCredentialRefs = (value: unknown): readonly CredentialRef[] => {
    if (isCredentialRefString(value)) {return [parseCredentialRef(value)];}
    if (Array.isArray(value)) {
        const collected: CredentialRef[] = [];
        for (const child of value) {
            collected.push(...collectCredentialRefs(child));
        }
        return collected;
    }
    if (isRecord(value)) {
        const collected: CredentialRef[] = [];
        for (const child of Object.values(value)) {
            collected.push(...collectCredentialRefs(child));
        }
        return collected;
    }
    return [];
};

export const resolveCredentialRefsDeep = async (
    value: unknown,
    resolve: CredentialResolver['resolve'],
): Promise<unknown> => {
    if (isCredentialRefString(value)) {
        return await resolve(parseCredentialRef(value));
    }
    if (Array.isArray(value)) {
        const rewritten: unknown[] = new Array<unknown>(value.length);
        for (let index = 0; index < value.length; index += 1) {
            rewritten[index] = await resolveCredentialRefsDeep(value[index], resolve);
        }
        return rewritten;
    }
    if (isRecord(value)) {
        const rewritten: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value)) {
            rewritten[key] = await resolveCredentialRefsDeep(child, resolve);
        }
        return rewritten;
    }
    return value;
};