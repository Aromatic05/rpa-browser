import { normalizeText } from './runtime_store';
import type { EntityKind, FinalEntityRecord } from './types';

type EntityQueryFilters = {
    kind?: EntityKind | EntityKind[];
    businessTag?: string | string[];
    query?: string;
};

export const filterFinalEntities = (
    entities: FinalEntityRecord[],
    filters: EntityQueryFilters,
): FinalEntityRecord[] => {
    const kinds = normalizeKindFilter(filters.kind);
    const tags = normalizeTextSet(filters.businessTag);
    const query = normalizeText(filters.query)?.toLowerCase();

    return entities.filter((entity) => {
        if (kinds && !kinds.has(entity.kind)) return false;

        if (tags) {
            const businessTag = normalizeText(entity.businessTag);
            if (!businessTag || !tags.has(businessTag)) return false;
        }

        if (!query) return true;
        return matchesQuery(entity, query);
    });
};

const matchesQuery = (entity: FinalEntityRecord, query: string): boolean => {
    const haystack = [
        entity.id,
        entity.entityId,
        entity.nodeId,
        entity.kind,
        entity.type,
        entity.name,
        entity.businessTag,
    ]
        .map((value) => normalizeText(String(value || ''))?.toLowerCase())
        .filter((value): value is string => Boolean(value));

    return haystack.some((value) => value.includes(query));
};

const normalizeKindFilter = (kind?: EntityKind | EntityKind[]): Set<EntityKind> | null => {
    if (!kind) return null;
    if (Array.isArray(kind)) {
        const normalized = kind.filter((item): item is EntityKind => Boolean(item));
        return normalized.length > 0 ? new Set(normalized) : null;
    }
    return new Set([kind]);
};

const normalizeTextSet = (input?: string | string[]): Set<string> | null => {
    if (!input) return null;
    const values = Array.isArray(input) ? input : [input];
    const normalized = values
        .map((value) => normalizeText(value))
        .filter((value): value is string => Boolean(value));
    return normalized.length > 0 ? new Set(normalized) : null;
};
