import type {RunStepsDeps} from '../../automation/runner/run_steps';
import type {WorkspaceEntityRulesProvider} from '../../automation/snapshot/rules';
import type {DslCheckpointProvider} from '../../automation/dsl/emit';
import {
    buildEntityRuleExportIndex,
    workflowArtifactRevision,
    type EntityRuleExportIndex,
    type Workflow,
    type WorkflowArtifact,
    type WorkflowCatalogItem,
    type WorkflowRecording,
} from '../../automation/workflow';
import type {EffectReversibility} from '../../program/effects/contracts';
import {capabilitiesFor} from './capabilities';
import {
    LIBRARY_ASSET_KINDS,
    type AutomationSummary,
    type DemonstrationSummary,
    type Library,
    type LibraryAssetEvidenceDependency,
    type LibraryAssetId,
    type LibraryAssetKind,
    type LibraryAssetSummary,
    type LibraryAssetSummaryBase,
    type LibraryBodyLoadResult,
    type PageKnowledgeSummary,
    type ProcedureSummary,
    type RecoverySummary,
} from './contracts';
import {dependencyGraphForSource} from './dependency_graph';
import {signatureForDslSource} from './dsl_signature';
import {computeHealth} from './health';
import {createAssetValidator, type AssetValidator} from './validator';

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;
const MAX_PAGE_SCOPE = 8;

export type CreateWorkspaceLibraryOptions = Readonly<{
    workspaceName: string;
    deps: RunStepsDeps;
}>;

export const createWorkspaceLibrary = (options: CreateWorkspaceLibraryOptions): Library => {
    const validator = createAssetValidator(() => workspaceContext(options));
    return {
        list: async (listOptions) => {
            const kinds = listOptions?.kind ? [listOptions.kind] : [...LIBRARY_ASSET_KINDS];
            const summaries: LibraryAssetSummary[] = [];
            for (const kind of kinds) {
                for (const item of catalogItems(options, kind)) {
                    const summary = buildSummary(options, validator, kind, item);
                    if (summary) {summaries.push(summary);}
                }
            }
            summaries.sort((left, right) =>
                left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
            return Object.freeze(bounded(summaries, listOptions?.limit));
        },
        summary: async (id) => {
            const item = catalogItem(options, id.kind, id.name);
            return item ? buildSummary(options, validator, id.kind, item) : null;
        },
        loadBody: async (id) => loadBody(options, id),
        validate: async (id) => validator.validate(id),
        health: async (id) => {
            const current = currentRevisionAndDependencies(options, id);
            return computeHealth({
                assetRevision: current.revision,
                dependencies: current.dependencies,
                evidence: validator.evidence(id),
            });
        },
    };
};

const workspaceContext = (options: CreateWorkspaceLibraryOptions): AssetValidatorContext => {
    const workspace = options.deps.resolveWorkspace(options.workspaceName);
    const workflow = workspace.workflow;
    return {
        workflow,
        checkpointProvider: workspace.checkpoint.getProvider(workflow),
        entityRulesProvider: workspace.entityRules.getProvider(workflow),
    };
};

type AssetValidatorContext = Readonly<{
    workflow: Workflow;
    checkpointProvider: DslCheckpointProvider;
    entityRulesProvider: WorkspaceEntityRulesProvider;
}>;

const catalogItems = (
    options: CreateWorkspaceLibraryOptions,
    kind: LibraryAssetKind,
): WorkflowCatalogItem[] => workspaceContext(options).workflow.list({kind: toWorkflowKind(kind)});

const catalogItem = (
    options: CreateWorkspaceLibraryOptions,
    kind: LibraryAssetKind,
    name: string,
): WorkflowCatalogItem | null =>
    catalogItems(options, kind).find((item) => item.name === name) ?? null;

const toWorkflowKind = (kind: LibraryAssetKind): WorkflowArtifact['kind'] => {
    if (kind === 'automation') {return 'dsl';}
    if (kind === 'procedure' || kind === 'recovery') {return 'checkpoint';}
    if (kind === 'demonstration') {return 'recording';}
    return 'entity_rules';
};

const buildSummary = (
    options: CreateWorkspaceLibraryOptions,
    validator: AssetValidator,
    kind: LibraryAssetKind,
    item: WorkflowCatalogItem,
): LibraryAssetSummary | null => {
    if (kind === 'automation') {return automationSummary(options, validator, item);}
    if (kind === 'procedure') {return procedureSummary(options, validator, item);}
    if (kind === 'recovery') {return recoverySummary(options, validator, item);}
    if (kind === 'demonstration') {return demonstrationSummary(options, validator, item);}
    return pageKnowledgeSummary(options, validator, item);
};

const automationSummary = (
    options: CreateWorkspaceLibraryOptions,
    validator: AssetValidator,
    item: WorkflowCatalogItem,
): AutomationSummary | null => {
    const artifact = readArtifact(options, 'dsl', item.name);
    if (artifact?.kind !== 'dsl') {return null;}
    const id: LibraryAssetId = {kind: 'automation', name: item.name};
    const revision = workflowArtifactRevision(artifact);
    const dependencies = dependencyGraphForSource({source: artifact.content, workflow: workflow(options)});
    return Object.freeze({
        ...summaryBase(options, validator, id, item, revision, dependencies),
        kind: 'automation',
        purpose: item.title || item.name,
    });
};

const procedureSummary = (
    options: CreateWorkspaceLibraryOptions,
    validator: AssetValidator,
    item: WorkflowCatalogItem,
): ProcedureSummary | null => {
    const artifact = readArtifact(options, 'checkpoint', item.name);
    if (artifact?.kind !== 'checkpoint') {return null;}
    const checkpointKind = artifact.checkpoint.kind ?? 'procedure';
    if (checkpointKind !== 'procedure') {return null;}
    const id: LibraryAssetId = {kind: 'procedure', name: item.name};
    const revision = workflowArtifactRevision(artifact);
    const dependencies = artifact.bodyDsl !== undefined
        ? dependencyGraphForSource({source: artifact.bodyDsl, workflow: workflow(options)})
        : Object.freeze([]);
    const signature = artifact.bodyDsl !== undefined
        ? signatureForDslSource(artifact.bodyDsl)
        : {
            inputs: Object.freeze([...Object.keys(artifact.checkpoint.input ?? {})].sort()),
            outputs: Object.freeze([...Object.keys(artifact.checkpoint.output ?? {})].sort()),
        };
    return Object.freeze({
        ...summaryBase(options, validator, id, item, revision, dependencies),
        title: artifact.checkpoint.name?.trim() || item.title || item.name,
        kind: 'procedure',
        meaning: artifact.checkpoint.name?.trim() || item.title || item.name,
        inputs: signature.inputs,
        outputs: signature.outputs,
    });
};

const recoverySummary = (
    options: CreateWorkspaceLibraryOptions,
    validator: AssetValidator,
    item: WorkflowCatalogItem,
): RecoverySummary | null => {
    const artifact = readArtifact(options, 'checkpoint', item.name);
    if (artifact?.kind !== 'checkpoint') {return null;}
    const checkpointKind = artifact.checkpoint.kind ?? 'procedure';
    if (checkpointKind !== 'recovery') {return null;}
    const id: LibraryAssetId = {kind: 'recovery', name: item.name};
    const revision = workflowArtifactRevision(artifact);
    const dependencies = artifact.bodyDsl !== undefined
        ? dependencyGraphForSource({source: artifact.bodyDsl, workflow: workflow(options)})
        : Object.freeze([]);
    const trigger = artifact.checkpoint.trigger;
    return Object.freeze({
        ...summaryBase(options, validator, id, item, revision, dependencies),
        title: artifact.checkpoint.name?.trim() || item.title || item.name,
        kind: 'recovery',
        meaning: artifact.checkpoint.name?.trim() || item.title || item.name,
        triggerSummary: Object.freeze({
            rules: Object.freeze([...new Set((trigger?.matchRules ?? []).map((rule) => ruleKind(rule)))].sort()),
            entityRules: Boolean(trigger?.entityRules),
        }),
        policySummary: Object.freeze({
            ...(artifact.checkpoint.policy?.maxAttempts !== undefined
                ? {maxAttempts: artifact.checkpoint.policy.maxAttempts}
                : {}),
            retryOriginal: Boolean(artifact.checkpoint.policy?.retryOriginal),
        }),
    });
};

const ruleKind = (rule: {errorCode?: string; stepName?: string; urlIncludes?: string; textVisible?: string; entityExists?: unknown}): string => {
    if (rule.errorCode !== undefined) {return 'errorCode';}
    if (rule.stepName !== undefined) {return 'stepName';}
    if (rule.urlIncludes !== undefined) {return 'urlIncludes';}
    if (rule.textVisible !== undefined) {return 'textVisible';}
    return 'entityExists';
};

const demonstrationSummary = (
    options: CreateWorkspaceLibraryOptions,
    validator: AssetValidator,
    item: WorkflowCatalogItem,
): DemonstrationSummary | null => {
    const artifact = readArtifact(options, 'recording', item.name);
    if (artifact?.kind !== 'recording') {return null;}
    const id: LibraryAssetId = {kind: 'demonstration', name: item.name};
    const revision = workflowArtifactRevision(artifact);
    const stepCount = artifact.steps.length;
    return Object.freeze({
        ...summaryBase(options, validator, id, item, revision, Object.freeze([])),
        kind: 'demonstration',
        meaning: item.title || item.name,
        pageScope: Object.freeze(pageScope(artifact)),
        stepCount,
        replayable: stepCount > 0,
    });
};

const pageKnowledgeSummary = (
    options: CreateWorkspaceLibraryOptions,
    validator: AssetValidator,
    item: WorkflowCatalogItem,
): PageKnowledgeSummary | null => {
    const artifact = readArtifact(options, 'entity_rules', item.name);
    if (artifact?.kind !== 'entity_rules') {return null;}
    const id: LibraryAssetId = {kind: 'page_knowledge', name: item.name};
    const revision = workflowArtifactRevision(artifact);
    const resolution = buildEntityRuleExportIndex(artifact);
    const counts = resolution.index ? countPageKnowledge(resolution.index) : emptyCounts();
    return Object.freeze({
        ...summaryBase(options, validator, id, item, revision, Object.freeze([])),
        kind: 'page_knowledge',
        meaning: item.title || item.name,
        applicability: Object.freeze(artifact.page
            ? {
                kind: artifact.page.kind,
                ...(artifact.page.urlPattern !== undefined ? {urlPattern: artifact.page.urlPattern} : {}),
            }
            : {kind: 'unknown'}),
        entityCount: counts.entities,
        fieldCount: counts.fields,
        actionCount: counts.actions,
        rowActionCount: counts.rowActions,
        ...(resolution.index?.entities[0]?.primaryKey
            ? {primaryKey: resolution.index.entities[0].primaryKey.fieldKey}
            : {}),
        safety: Object.freeze(counts.safety),
    });
};

const summaryBase = (
    options: CreateWorkspaceLibraryOptions,
    validator: AssetValidator,
    id: LibraryAssetId,
    item: WorkflowCatalogItem,
    revision: string,
    dependencies: readonly LibraryAssetEvidenceDependency[],
): LibraryAssetSummaryBase => ({
    name: id.name,
    title: item.title || id.name,
    updatedAt: item.updatedAt,
    revision,
    dependencies: Object.freeze(dependencies.map(({kind, name}) => Object.freeze({kind, name}))),
    health: computeHealth({
        assetRevision: revision,
        dependencies,
        evidence: validator.evidence(id),
    }),
    capabilities: capabilitiesFor(id.kind),
});

const currentRevisionAndDependencies = (
    options: CreateWorkspaceLibraryOptions,
    id: LibraryAssetId,
): {revision: string | null; dependencies: readonly LibraryAssetEvidenceDependency[]} => {
    if (id.kind === 'automation') {
        const artifact = readArtifact(options, 'dsl', id.name);
        if (artifact?.kind !== 'dsl') {return {revision: null, dependencies: Object.freeze([])};}
        return {
            revision: workflowArtifactRevision(artifact),
            dependencies: dependencyGraphForSource({source: artifact.content, workflow: workflow(options)}),
        };
    }
    if (id.kind === 'procedure' || id.kind === 'recovery') {
        const artifact = readArtifact(options, 'checkpoint', id.name);
        if (artifact?.kind !== 'checkpoint') {return {revision: null, dependencies: Object.freeze([])};}
        return {
            revision: workflowArtifactRevision(artifact),
            dependencies: artifact.bodyDsl !== undefined
                ? dependencyGraphForSource({source: artifact.bodyDsl, workflow: workflow(options)})
                : Object.freeze([]),
        };
    }
    const artifact = readArtifact(options, toWorkflowKind(id.kind), id.name);
    if (!artifact) {return {revision: null, dependencies: Object.freeze([])};}
    return {revision: workflowArtifactRevision(artifact), dependencies: Object.freeze([])};
};

const loadBody = (
    options: CreateWorkspaceLibraryOptions,
    id: LibraryAssetId,
): LibraryBodyLoadResult => {
    if (id.kind === 'recovery' || id.kind === 'page_knowledge') {
        return Object.freeze({status: 'unsupported', kind: id.kind, name: id.name});
    }
    const artifact = readArtifact(options, toWorkflowKind(id.kind), id.name);
    if (!artifact) {
        return Object.freeze({status: 'not_found', kind: id.kind, name: id.name});
    }
    if (id.kind === 'automation') {
        if (artifact.kind !== 'dsl') {
            return Object.freeze({status: 'not_found', kind: id.kind, name: id.name});
        }
        return Object.freeze({
            status: 'loaded',
            kind: 'automation',
            name: id.name,
            source: artifact.content,
            revision: workflowArtifactRevision(artifact),
        });
    }
    if (id.kind === 'procedure') {
        if (artifact.kind !== 'checkpoint' || artifact.bodyDsl === undefined) {
            return Object.freeze({status: 'not_found', kind: id.kind, name: id.name});
        }
        return Object.freeze({
            status: 'loaded',
            kind: 'procedure',
            name: id.name,
            body: artifact.bodyDsl,
            revision: workflowArtifactRevision(artifact),
        });
    }
    if (artifact.kind !== 'recording') {
        return Object.freeze({status: 'not_found', kind: id.kind, name: id.name});
    }
    return Object.freeze({
        status: 'loaded',
        kind: 'demonstration',
        name: id.name,
        steps: Object.freeze([...artifact.steps]),
        revision: workflowArtifactRevision(artifact),
    });
};

const readArtifact = (
    options: CreateWorkspaceLibraryOptions,
    kind: WorkflowArtifact['kind'],
    name: string,
): ReturnType<Workflow['get']> => {
    try {
        return workflow(options).get(name, {kind});
    } catch {
        return null;
    }
};

const workflow = (options: CreateWorkspaceLibraryOptions): Workflow =>
    workspaceContext(options).workflow;

const pageScope = (artifact: WorkflowRecording): string[] => {
    const titles: string[] = [];
    for (const tab of artifact.recording.initialTabs) {
        if (tab.title && !titles.includes(tab.title)) {titles.push(tab.title);}
        if (titles.length >= MAX_PAGE_SCOPE) {break;}
    }
    return titles;
};

const countPageKnowledge = (index: EntityRuleExportIndex): PageKnowledgeCounts => {
    let fields = 0;
    let actions = 0;
    let rowActions = 0;
    const safety: Record<EffectReversibility, number> = {
        reversible: 0,
        compensatable: 0,
        irreversible: 0,
        unknown: 0,
    };
    for (const entity of index.entities) {
        fields += entity.fields.length;
        actions += entity.actions.length;
        rowActions += entity.rowActions.length;
        for (const member of [...entity.fields, ...entity.actions, ...entity.rowActions]) {
            const reversibility = member.effect?.reversibility ?? 'unknown';
            safety[reversibility] += 1;
        }
    }
    return {entities: index.entities.length, fields, actions, rowActions, safety};
};

type PageKnowledgeCounts = Readonly<{
    entities: number;
    fields: number;
    actions: number;
    rowActions: number;
    safety: Readonly<Record<EffectReversibility, number>>;
}>;

const emptyCounts = (): PageKnowledgeCounts => ({
    entities: 0,
    fields: 0,
    actions: 0,
    rowActions: 0,
    safety: {reversible: 0, compensatable: 0, irreversible: 0, unknown: 0},
});

const bounded = <T>(items: readonly T[], limit: number | undefined): readonly T[] => {
    const capped = Math.min(Math.max(0, limit ?? DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT);
    return items.slice(0, capped);
};