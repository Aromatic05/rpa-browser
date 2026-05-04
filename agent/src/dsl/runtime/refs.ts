import type { RefExpr } from '../ast/types';
import type { DslScope } from './scope';
import { getDslValue } from './scope';

export const resolveDslValue = (value: unknown, scope: DslScope): unknown => {
    if (isRefExpr(value)) {
        return getDslValue(scope, value.ref);
    }
    if (Array.isArray(value)) {
        return value.map((item) => resolveDslValue(item, scope));
    }
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            out[key] = resolveDslValue(entry, scope);
        }
        return out;
    }
    return value;
};

const isRefExpr = (value: unknown): value is RefExpr => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {return false;}
    return (value as { kind?: unknown }).kind === 'ref' && typeof (value as { ref?: unknown }).ref === 'string';
};
