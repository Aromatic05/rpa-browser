/**
 * Product Library adapter: maps the committed `agent/library` asset summaries
 * into the bounded, sanitized `WorkspaceLibrarySummary` the product surface
 * renders. Only user-facing names, descriptions and the real dependency-health
 * evidence pass through; bodies, steps, selectors and revisions never do.
 */
import type {LibraryAssetSummary} from '../library/contracts';
import type {WorkspaceLibraryHealth, WorkspaceLibrarySummary} from './types';

const HEALTH_VALUES: ReadonlyArray<WorkspaceLibraryHealth> = [
    'ready',
    'needs_review',
    'broken',
    'unknown',
];

const healthOf = (summary: LibraryAssetSummary): WorkspaceLibraryHealth =>
    HEALTH_VALUES.includes(summary.health) ? summary.health : 'unknown';

export const librarySummaryFrom = (
    summaries: ReadonlyArray<LibraryAssetSummary>,
): WorkspaceLibrarySummary => {
    const automations: Array<WorkspaceLibrarySummary['automations'][number]> = [];
    const procedures: Array<WorkspaceLibrarySummary['procedures'][number]> = [];
    const recoveries: Array<WorkspaceLibrarySummary['recoveries'][number]> = [];
    const demonstrations: Array<WorkspaceLibrarySummary['demonstrations'][number]> = [];
    const pageKnowledge: Array<WorkspaceLibrarySummary['pageKnowledge'][number]> = [];
    for (const asset of summaries) {
        switch (asset.kind) {
            case 'automation':
                automations.push(Object.freeze({
                    name: asset.name,
                    description: asset.purpose,
                    status: healthOf(asset),
                }));
                break;
            case 'procedure':
                procedures.push(Object.freeze({name: asset.name, health: healthOf(asset)}));
                break;
            case 'recovery':
                recoveries.push(Object.freeze({name: asset.name, health: healthOf(asset)}));
                break;
            case 'demonstration':
                demonstrations.push(Object.freeze({
                    name: asset.name,
                    stepCount: asset.stepCount,
                    health: healthOf(asset),
                }));
                break;
            case 'page_knowledge':
                pageKnowledge.push(Object.freeze({
                    profileName: asset.name,
                    label: asset.title,
                    ...(asset.applicability.kind ? {pageKind: asset.applicability.kind} : {}),
                    ...(asset.applicability.urlPattern === undefined
                        ? {}
                        : {urlPattern: asset.applicability.urlPattern}),
                    entityCount: asset.entityCount,
                    health: healthOf(asset),
                }));
                break;
        }
    }
    return Object.freeze({
        automations: Object.freeze(automations),
        procedures: Object.freeze(procedures),
        recoveries: Object.freeze(recoveries),
        demonstrations: Object.freeze(demonstrations),
        pageKnowledge: Object.freeze(pageKnowledge),
    });
};
