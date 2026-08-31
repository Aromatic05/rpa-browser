import type {EntityKind} from '../../runner/steps/types';

export const normalizeText = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export const uniqueBy = <T>(items: readonly T[], key: (item: T) => string): T[] => {
    const seen = new Set<string>();
    return items.filter((item) => {
        const value = key(item);
        if (seen.has(value)) {return false;}
        seen.add(value);
        return true;
    });
};

export const readEntityKind = (value: unknown): EntityKind | null =>
    typeof value === 'string'
        && ['form', 'table', 'dialog', 'list', 'panel', 'toolbar', 'kv'].includes(value)
        ? value as EntityKind
        : null;
