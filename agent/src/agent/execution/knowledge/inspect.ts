import {projectCatalogEntry} from './catalog';
import type {
    KnowledgeCatalogOnlyInspect,
    KnowledgeInspectInput,
    KnowledgeInspectResult,
    KnowledgeNotFoundInspect,
    KnowledgeSeamDeps,
    PageKnowledgeEntity,
    ProcedureKnowledgeInspect,
} from './contracts';
import {KNOWLEDGE_INSPECT_MAX_ENTITIES} from './contracts';
import type {EntityRuleExportEntry, WorkflowEntityRules} from '../../../automation/workflow';
import {projectEntityRuleEntities} from '../../../automation/snapshot/rules';

type EntityNameView = Readonly<{
    businessTag: string;
    label?: string;
    fields?: readonly Readonly<{fieldKey: string; label: string}>[];
    actions?: readonly Readonly<{actionIntent: string; label: string}>[];
    rowActions?: readonly Readonly<{actionIntent: string; label: string}>[];
    columns?: readonly Readonly<{fieldKey: string; label: string}>[];
}>;

const nameIndex = (profile: WorkflowEntityRules): ReadonlyMap<string, EntityNameView> =>
    new Map(projectEntityRuleEntities(profile).map((entity) => [entity.businessTag, entity]));

const noneFound = (kind: KnowledgeInspectInput['kind'], name: string): KnowledgeNotFoundInspect =>
    Object.freeze({status: 'not_found', kind, name});

const inspectProcedure = async (
    deps: KnowledgeSeamDeps,
    name: string,
    includeBody: boolean,
): Promise<KnowledgeInspectResult> => {
    const summary = await deps.library.summary({kind: 'procedure', name});
    if (summary?.kind !== 'procedure') {return noneFound('procedure', name);}
    const result: ProcedureKnowledgeInspect = {
        status: 'loaded',
        kind: 'procedure',
        name,
        meaning: summary.meaning,
        inputs: summary.inputs,
        outputs: summary.outputs,
        health: summary.health,
        capabilities: summary.capabilities,
        dependencies: summary.dependencies,
    };
    if (!includeBody) {return Object.freeze(result);}
    const loaded = await deps.library.loadBody({kind: 'procedure', name});
    if (loaded.status === 'loaded' && loaded.kind === 'procedure') {
        return Object.freeze({...result, body: loaded.body});
    }
    return Object.freeze(result);
};

const inspectPageKnowledge = async (
    deps: KnowledgeSeamDeps,
    name: string,
): Promise<KnowledgeInspectResult> => {
    const summary = await deps.library.summary({kind: 'page_knowledge', name});
    if (summary?.kind !== 'page_knowledge') {return noneFound('page_knowledge', name);}
    const resolution = deps.entityRules.resolveExports(name);
    if (!resolution.index) {
        return Object.freeze({
            status: 'invalid',
            kind: 'page_knowledge',
            name,
            meaning: summary.meaning,
            health: summary.health,
            diagnostics: Object.freeze(resolution.diagnostics.map(({code, message}) => Object.freeze({code, message}))),
        });
    }
    const profile = deps.entityRules.getProfile(name);
    const names = profile ? nameIndex(profile) : new Map<string, EntityNameView>();
    const entities = Object.freeze(
        resolution.index.entities
            .slice(0, KNOWLEDGE_INSPECT_MAX_ENTITIES)
            .map((entry) => projectPageKnowledgeEntity(entry, names)),
    );
    return Object.freeze({
        status: 'loaded',
        kind: 'page_knowledge',
        name,
        meaning: summary.meaning,
        health: summary.health,
        capabilities: summary.capabilities,
        applicability: summary.applicability,
        entities,
    });
};

const projectPageKnowledgeEntity = (
    entry: EntityRuleExportEntry,
    names: ReadonlyMap<string, EntityNameView>,
): PageKnowledgeEntity => {
    const view = names.get(entry.businessTag);
    const fieldNames = new Map((view?.fields ?? []).map((item) => [item.fieldKey, item.label]));
    const actionNames = new Map((view?.actions ?? []).map((item) => [item.actionIntent, item.label]));
    const rowActionNames = new Map((view?.rowActions ?? []).map((item) => [item.actionIntent, item.label]));
    return Object.freeze({
        entityKey: entry.entityKey,
        businessTag: entry.businessTag,
        kind: entry.kind,
        ...(view?.label ? {label: view.label} : {}),
        fields: Object.freeze(entry.fields.map((field) => Object.freeze({
            fieldKey: field.fieldKey,
            ...(fieldNames.get(field.fieldKey) ? {name: fieldNames.get(field.fieldKey)} : {}),
            targetKind: field.targetKind,
            reversibility: field.effect?.reversibility ?? 'unknown',
        }))),
        actions: Object.freeze(entry.actions.map((action) => Object.freeze({
            actionIntent: action.actionIntent,
            ...(actionNames.get(action.actionIntent) ? {name: actionNames.get(action.actionIntent)} : {}),
            targetKind: action.targetKind,
            reversibility: action.effect?.reversibility ?? 'unknown',
        }))),
        rowActions: Object.freeze(entry.rowActions.map((action) => Object.freeze({
            actionIntent: action.actionIntent,
            ...(rowActionNames.get(action.actionIntent) ? {name: rowActionNames.get(action.actionIntent)} : {}),
            reversibility: action.effect?.reversibility ?? 'unknown',
        }))),
        columns: Object.freeze(entry.columns.map((column) => column.fieldKey)),
        supportedQueries: entry.supportedQueries,
        ...(entry.primaryKey ? {primaryKey: Object.freeze({fieldKey: entry.primaryKey.fieldKey})} : {}),
    });
};

const inspectCatalogOnly = async (
    deps: KnowledgeSeamDeps,
    kind: 'recovery' | 'demonstration',
    name: string,
    note: string,
): Promise<KnowledgeCatalogOnlyInspect> => {
    const summary = await deps.library.summary({kind, name});
    if (!summary) {return {...noneFound(kind, name)} as unknown as KnowledgeCatalogOnlyInspect;}
    return Object.freeze({...projectCatalogEntry(summary), status: 'catalog_only', note});
};

const RECOVERY_CATALOG_ONLY_NOTE = [
    'Recovery assets are automatic deterministic runtime knowledge. The retained runtime applies them when their triggers match;',
    'the Agent does not load or invoke them directly and never inlines their bodies.',
].join(' ');

const DEMONSTRATION_CATALOG_ONLY_NOTE = [
    'Demonstrations are replay-only. The recorder replays the stored steps; raw steps are never exposed to the model',
    'and the model cannot replay a Demonstration.',
].join(' ');

export const inspectKnowledgeAsset = async (
    deps: KnowledgeSeamDeps,
    input: KnowledgeInspectInput,
): Promise<KnowledgeInspectResult> => {
    const name = input.name.trim();
    if (!name) {return noneFound(input.kind, name);}
    if (input.kind === 'procedure') {
        return inspectProcedure(deps, name, input.includeBody === true);
    }
    if (input.kind === 'page_knowledge') {
        return inspectPageKnowledge(deps, name);
    }
    if (input.kind === 'recovery') {
        return inspectCatalogOnly(deps, 'recovery', name, RECOVERY_CATALOG_ONLY_NOTE);
    }
    if (input.kind === 'demonstration') {
        return inspectCatalogOnly(deps, 'demonstration', name, DEMONSTRATION_CATALOG_ONLY_NOTE);
    }
    return Object.freeze({status: 'unsupported', kind: 'automation', name});
};