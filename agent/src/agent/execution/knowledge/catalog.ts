import type {LibraryAssetSummary} from '../../library/contracts';
import {
    KNOWLEDGE_CATALOG_LIMIT_DEFAULT,
    KNOWLEDGE_CATALOG_LIMIT_MAX,
    type KnowledgeCatalogEntry,
    type KnowledgeCatalogQuery,
    type KnowledgeCatalogResult,
    type KnowledgeSeamDeps,
} from './contracts';

export const projectCatalogEntry = (summary: LibraryAssetSummary): KnowledgeCatalogEntry => {
    const base = {
        id: Object.freeze({kind: summary.kind, name: summary.name}),
        title: summary.title,
        meaning: summary.kind === 'automation' ? summary.purpose : summary.meaning,
        health: summary.health,
        capabilities: summary.capabilities,
    };
    if (summary.kind === 'automation') {
        return Object.freeze({...base, kind: 'automation' as const, purpose: summary.purpose});
    }
    if (summary.kind === 'procedure') {
        return Object.freeze({...base, kind: 'procedure' as const, inputs: summary.inputs, outputs: summary.outputs});
    }
    if (summary.kind === 'recovery') {
        return Object.freeze({
            ...base,
            kind: 'recovery' as const,
            triggerSummary: summary.triggerSummary,
            policySummary: summary.policySummary,
        });
    }
    if (summary.kind === 'demonstration') {
        return Object.freeze({
            ...base,
            kind: 'demonstration' as const,
            pageScope: summary.pageScope,
            stepCount: summary.stepCount,
            replayable: summary.replayable,
        });
    }
    return Object.freeze({
        ...base,
        kind: 'page_knowledge' as const,
        applicability: summary.applicability,
        entityCount: summary.entityCount,
        fieldCount: summary.fieldCount,
        actionCount: summary.actionCount,
        rowActionCount: summary.rowActionCount,
        ...(summary.primaryKey ? {primaryKey: summary.primaryKey} : {}),
        safety: summary.safety,
    });
};

const boundedCatalogLimit = (limit: number | undefined): number =>
    Math.min(Math.max(1, Math.floor(limit ?? KNOWLEDGE_CATALOG_LIMIT_DEFAULT)), KNOWLEDGE_CATALOG_LIMIT_MAX);

const normalizedFilter = (filter: string | undefined): string | null => {
    const value = filter?.trim().toLowerCase();
    return value ? value : null;
};

const matchesFilter = (entry: KnowledgeCatalogEntry, filter: string): boolean => {
    const haystack = [
        entry.id.name,
        entry.title,
        entry.meaning,
        ...('inputs' in entry ? entry.inputs : []),
        ...('outputs' in entry ? entry.outputs : []),
        ...('triggerSummary' in entry ? entry.triggerSummary.rules : []),
        ...('pageScope' in entry ? entry.pageScope : []),
    ].map((value) => value.toLowerCase());
    return haystack.some((value) => value.includes(filter));
};

export const queryKnowledgeCatalog = async (
    deps: KnowledgeSeamDeps,
    query: KnowledgeCatalogQuery,
): Promise<KnowledgeCatalogResult> => {
    const limit = boundedCatalogLimit(query.limit);
    const filter = normalizedFilter(query.filter);
    const listed = await deps.library.list(query.kind ? {kind: query.kind, limit: undefined} : undefined);
    const matches: KnowledgeCatalogEntry[] = [];
    for (const summary of listed) {
        const entry = projectCatalogEntry(summary);
        if (filter && !matchesFilter(entry, filter)) {continue;}
        matches.push(entry);
    }
    const entries = Object.freeze(matches.slice(0, limit));
    return {
        count: entries.length,
        truncated: matches.length > limit,
        entries,
    };
};