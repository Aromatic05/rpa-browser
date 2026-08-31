import type {
    Library,
    LibraryAssetId,
    LibraryAssetSummary,
} from '../library/contracts';
import type {CatalogEntry, CatalogListOptions, GuidanceCatalog} from './contracts';

export const createGuidanceCatalog = (library: Library): GuidanceCatalog => ({
    list: async (options?: CatalogListOptions) => {
        const summaries = await library.list(options);
        return Object.freeze(summaries.map((summary) => toEntry(summary)));
    },
    entry: async (id: LibraryAssetId) => {
        const summary = await library.summary(id);
        return summary ? toEntry(summary) : null;
    },
    loadBody: (id: LibraryAssetId) => library.loadBody(id),
    validate: (id: LibraryAssetId) => library.validate(id),
    health: (id: LibraryAssetId) => library.health(id),
});

const toEntry = (summary: LibraryAssetSummary): CatalogEntry => {
    if (summary.kind === 'automation') {
        return Object.freeze({
            name: summary.name,
            kind: 'automation',
            meaning: summary.purpose,
            dependencies: summary.dependencies,
            health: summary.health,
            counts: Object.freeze({kind: 'automation', references: summary.dependencies.length}),
        });
    }
    if (summary.kind === 'procedure') {
        return Object.freeze({
            name: summary.name,
            kind: 'procedure',
            meaning: summary.meaning,
            dependencies: summary.dependencies,
            health: summary.health,
            counts: Object.freeze({
                kind: 'procedure',
                inputs: summary.inputs.length,
                outputs: summary.outputs.length,
            }),
        });
    }
    if (summary.kind === 'recovery') {
        return Object.freeze({
            name: summary.name,
            kind: 'recovery',
            meaning: summary.meaning,
            dependencies: summary.dependencies,
            health: summary.health,
            counts: Object.freeze({
                kind: 'recovery',
                triggerRules: summary.triggerSummary.rules.length,
                ...(summary.policySummary.maxAttempts !== undefined
                    ? {maxAttempts: summary.policySummary.maxAttempts}
                    : {}),
            }),
        });
    }
    if (summary.kind === 'demonstration') {
        return Object.freeze({
            name: summary.name,
            kind: 'demonstration',
            meaning: summary.meaning,
            dependencies: summary.dependencies,
            health: summary.health,
            counts: Object.freeze({kind: 'demonstration', steps: summary.stepCount}),
        });
    }
    return Object.freeze({
        name: summary.name,
        kind: 'page_knowledge',
        meaning: summary.meaning,
        applicability: summary.applicability,
        dependencies: summary.dependencies,
        health: summary.health,
        counts: Object.freeze({
            kind: 'page_knowledge',
            entities: summary.entityCount,
            fields: summary.fieldCount,
            actions: summary.actionCount,
        }),
    });
};