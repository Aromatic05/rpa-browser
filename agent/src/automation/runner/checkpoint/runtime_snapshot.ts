import {
    createDslEntityRulesResolver,
    type DslEntityRulesResolver,
    type DslResolveBundleResolution,
    type DslResolveResolver,
} from '../../dsl/link';
import {
    buildEntityRuleExportIndex,
    validateWorkflowEntityRules,
    type Workflow,
    type WorkflowEntityRules,
} from '../../workflow';
import type {WorkspaceEntityRulesProvider} from '../../snapshot/rules';
import type {StepResolve} from '../steps/types';
import type {DslCheckpointProvider} from '../../dsl/emit';
import type {Checkpoint} from './types';
import {scanDslAssetReferences} from '../../../program/dsl/asset_references';

export const CHECKPOINT_RUNTIME_IMAGE_SCHEMA = 'rpa.dsl-runtime-closure';
export const CHECKPOINT_RUNTIME_IMAGE_VERSION = 1 as const;

export type CheckpointRuntimeSnapshotImage = Readonly<{
    schema: typeof CHECKPOINT_RUNTIME_IMAGE_SCHEMA;
    version: typeof CHECKPOINT_RUNTIME_IMAGE_VERSION;
    checkpoints: readonly Checkpoint[];
    checkpointStepResolves: Readonly<Record<string, Readonly<Record<string, StepResolve>>>>;
    checkpointBodies: Readonly<Record<string, string>>;
    entityRules: Readonly<{
        available: boolean;
        workflowName: string;
        selectedProfiles: readonly string[];
        profiles: Readonly<Record<string, WorkflowEntityRules>>;
    }>;
    resolveBundles: Readonly<Record<string, DslResolveBundleResolution>>;
}>;

export type CheckpointRuntimeSnapshot = {
    provider: DslCheckpointProvider;
    checkpointStepResolves: Record<string, Record<string, StepResolve>>;
    checkpointBodies: Record<string, string>;
    entityRulesProvider?: WorkspaceEntityRulesProvider;
    entityRulesResolver?: DslEntityRulesResolver;
    resolveResolver?: DslResolveResolver;
    image?: CheckpointRuntimeSnapshotImage;
};

const cloneFrozen = <T>(value: T): T => freeze(structuredClone(value));

const freeze = <T>(value: T): T => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {return value;}
    for (const child of Object.values(value)) {freeze(child);}
    return Object.freeze(value);
};

export const materializeCheckpointRuntimeSnapshot = (options: {
    checkpoints: readonly Checkpoint[];
    checkpointStepResolves: Record<string, Record<string, StepResolve>>;
    checkpointBodies: Record<string, string>;
    assetSources?: readonly string[];
    workflow?: Workflow;
    entityRulesProvider?: WorkspaceEntityRulesProvider | null;
}): CheckpointRuntimeSnapshot => {
    const references = collectAssetReferences(options.assetSources || Object.values(options.checkpointBodies));
    const selectedProfiles = [...new Set([
        ...(options.entityRulesProvider?.listProfiles() ?? []),
        ...references.entityRuleProfiles,
    ])].sort((left, right) => left.localeCompare(right));
    const entityProfiles = Object.fromEntries(selectedProfiles.flatMap((name) => {
        const profile = options.entityRulesProvider?.getProfile(name) ?? null;
        return profile ? [[name, cloneFrozen(profile)] as const] : [];
    }));
    const entityRules = cloneFrozen({
        available: options.entityRulesProvider?.availability === 'ready',
        workflowName: options.entityRulesProvider?.workflowName ?? '',
        selectedProfiles,
        profiles: entityProfiles,
    });
    const resolveBundles = Object.fromEntries([...references.resolveBundles].map((name) => [
        name,
        cloneFrozen(resolveBundleFromWorkflow(options.workflow, name)),
    ]));
    const image: CheckpointRuntimeSnapshotImage = cloneFrozen({
        schema: CHECKPOINT_RUNTIME_IMAGE_SCHEMA,
        version: CHECKPOINT_RUNTIME_IMAGE_VERSION,
        checkpoints: options.checkpoints,
        checkpointStepResolves: options.checkpointStepResolves,
        checkpointBodies: options.checkpointBodies,
        entityRules,
        resolveBundles,
    });
    return checkpointRuntimeSnapshotFromImage(image);
};

export const checkpointRuntimeSnapshotFromImage = (
    image: CheckpointRuntimeSnapshotImage,
): CheckpointRuntimeSnapshot => {
    const parsed = parseCheckpointRuntimeSnapshotImage(image);
    if (!parsed.ok) {throw new Error(parsed.error);}
    const frozen = parsed.image;
    const checkpoints = new Map(frozen.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
    const checkpointStepResolves = Object.fromEntries(Object.entries(frozen.checkpointStepResolves)
        .map(([id, resolves]) => [id, cloneFrozen(resolves)]));
    const checkpointBodies = cloneFrozen(frozen.checkpointBodies as Record<string, string>);
    const provider: DslCheckpointProvider = {
        getCheckpoint: (id) => checkpoints.get(id) ?? null,
        getCheckpointResolves: (id) => checkpointStepResolves[id] ?? null,
        getCheckpointBody: (id) => checkpointBodies[id] === undefined ? null : {
            source: checkpointBodies[id],
            stepResolves: checkpointStepResolves[id] ?? {},
        },
        listCheckpoints: () => [...checkpoints.values()],
    };
    const entityRulesProvider: WorkspaceEntityRulesProvider | undefined = frozen.entityRules.available
        ? {
            availability: 'ready',
            workflowName: frozen.entityRules.workflowName,
            listProfiles: () => [...frozen.entityRules.selectedProfiles]
                .filter((name) => frozen.entityRules.profiles[name] !== undefined),
            getProfile: (name) => frozen.entityRules.profiles[name]
                ? cloneFrozen(frozen.entityRules.profiles[name])
                : null,
            resolveExports: (name) => {
                const profile = frozen.entityRules.profiles[name];
                return profile
                    ? buildEntityRuleExportIndex(cloneFrozen(profile))
                    : {index: null, diagnostics: [{
                        code: 'entity_rule_exports.profile_not_found',
                        message: `entity-rules profile not found: ${name}`,
                    }]};
            },
        }
        : undefined;
    const entityRulesResolver = entityRulesProvider
        ? createDslEntityRulesResolver(entityRulesProvider)
        : undefined;
    const resolveResolver: DslResolveResolver | undefined = Object.keys(frozen.resolveBundles).length > 0
        ? {resolveBundle: (name) => frozen.resolveBundles[name]
            ? cloneFrozen(frozen.resolveBundles[name])
            : {resolves: null, diagnostics: []}}
        : undefined;
    return {
        provider,
        checkpointStepResolves,
        checkpointBodies,
        entityRulesProvider,
        entityRulesResolver,
        resolveResolver,
        image: frozen,
    };
};

export const materializeReferencedCheckpointRuntimeSnapshot = (options: {
    sources: readonly string[];
    checkpointProvider: DslCheckpointProvider;
    checkpoints?: readonly Checkpoint[];
    checkpointStepResolves?: Record<string, Record<string, StepResolve>>;
    checkpointBodies?: Record<string, string>;
    workflow?: Workflow;
    entityRulesProvider?: WorkspaceEntityRulesProvider | null;
}): CheckpointRuntimeSnapshot => {
    const checkpoints = new Map((options.checkpoints || []).map((checkpoint) => [checkpoint.id, checkpoint]));
    const stepResolves = {...(options.checkpointStepResolves || {})};
    const bodies = {...(options.checkpointBodies || {})};
    const pendingSources = [...options.sources];
    const queuedSources = new Set(pendingSources);
    const visitedSources = new Set<string>();

    while (pendingSources.length > 0) {
        const source = pendingSources.pop()!;
        if (visitedSources.has(source)) {continue;}
        visitedSources.add(source);
        const references = scanDslAssetReferences(source);
        for (const id of references.checkpoints) {
            const checkpoint = checkpoints.get(id) || options.checkpointProvider.getCheckpoint(id);
            if (!checkpoint) {continue;}
            checkpoints.set(id, checkpoint);
            if (stepResolves[id] === undefined) {
                stepResolves[id] = options.checkpointProvider.getCheckpointResolves?.(id) || {};
            }
            if (!checkpoint.body) {continue;}
            if (bodies[id] === undefined) {
                const body = options.checkpointProvider.getCheckpointBody?.(id);
                if (!body) {continue;}
                bodies[id] = body.source;
                stepResolves[id] = body.stepResolves;
            }
            if (!queuedSources.has(bodies[id])) {
                queuedSources.add(bodies[id]);
                pendingSources.push(bodies[id]);
            }
        }
    }

    const frozenAssetSources = new Set([
        ...visitedSources,
        ...Object.values(bodies),
    ]);
    return materializeCheckpointRuntimeSnapshot({
        checkpoints: [...checkpoints.values()],
        checkpointStepResolves: stepResolves,
        checkpointBodies: bodies,
        workflow: options.workflow,
        entityRulesProvider: options.entityRulesProvider,
        assetSources: [...frozenAssetSources],
    });
};

export const parseCheckpointRuntimeSnapshotImage = (
    value: unknown,
): {ok: true; image: CheckpointRuntimeSnapshotImage} | {ok: false; error: string} => {
    if (!isRecord(value)) {return {ok: false, error: 'runtime closure image must be an object'};}
    if (!exactKeys(value, [
        'schema', 'version', 'checkpoints', 'checkpointStepResolves', 'checkpointBodies',
        'entityRules', 'resolveBundles',
    ])) {return {ok: false, error: 'runtime closure image fields are invalid'};}
    if (value.schema !== CHECKPOINT_RUNTIME_IMAGE_SCHEMA || value.version !== CHECKPOINT_RUNTIME_IMAGE_VERSION) {
        return {ok: false, error: 'runtime closure image schema/version is unsupported'};
    }
    if (!Array.isArray(value.checkpoints) || !value.checkpoints.every(isCheckpointImage)) {
        return {ok: false, error: 'runtime closure checkpoints are invalid'};
    }
    if (!isRecordOfRecords(value.checkpointStepResolves)
        || !isRecordOfStrings(value.checkpointBodies)
        || !isEntityRulesImage(value.entityRules)
        || !isRecord(value.resolveBundles)
        || !Object.values(value.resolveBundles).every(isResolveBundle)) {
        return {ok: false, error: 'runtime closure maps are invalid'};
    }
    try {
        return {ok: true, image: cloneFrozen(JSON.parse(JSON.stringify(value)) as CheckpointRuntimeSnapshotImage)};
    } catch {
        return {ok: false, error: 'runtime closure image is not JSON serializable'};
    }
};

const resolveBundleFromWorkflow = (workflow: Workflow | undefined, name: string): DslResolveBundleResolution => {
    if (!workflow) {return {resolves: null, diagnostics: []};}
    const artifact = workflow.get(name, {kind: 'dsl'});
    return artifact?.kind === 'dsl'
        ? {resolves: cloneFrozen(artifact.stepResolves), diagnostics: []}
        : {resolves: null, diagnostics: []};
};

const collectAssetReferences = (sources: readonly string[]) => {
    const entityRuleProfiles = new Set<string>();
    const resolveBundles = new Set<string>();
    for (const source of sources) {
        const references = scanDslAssetReferences(source);
        references.entityRuleProfiles.forEach((name) => entityRuleProfiles.add(name));
        references.resolveBundles.forEach((name) => resolveBundles.add(name));
    }
    return {entityRuleProfiles, resolveBundles};
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, required: readonly string[]): boolean => {
    const allowed = new Set(required);
    return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
        && Object.keys(value).every((key) => allowed.has(key));
};
const isRecordOfStrings = (value: unknown): boolean => isRecord(value)
    && Object.values(value).every((entry) => typeof entry === 'string');
const isRecordOfRecords = (value: unknown): boolean => isRecord(value)
    && Object.values(value).every((entry) => isRecord(entry));
const isCheckpointImage = (value: unknown): boolean => isRecord(value)
    && typeof value.id === 'string'
    && (value.kind === undefined || value.kind === 'procedure' || value.kind === 'recovery');
const isDiagnosticArray = (value: unknown): boolean => Array.isArray(value)
    && value.every((entry) => isRecord(entry) && typeof entry.code === 'string' && typeof entry.message === 'string');
const isEntityRulesImage = (value: unknown): boolean => {
    if (!isRecord(value)
        || !exactKeys(value, ['available', 'workflowName', 'selectedProfiles', 'profiles'])
        || typeof value.available !== 'boolean'
        || typeof value.workflowName !== 'string'
        || !Array.isArray(value.selectedProfiles)
        || !value.selectedProfiles.every((name) => typeof name === 'string' && name.length > 0)
        || new Set(value.selectedProfiles).size !== value.selectedProfiles.length
        || !isRecord(value.profiles)) {
        return false;
    }
    if (!value.available && (value.workflowName !== '' || Object.keys(value.profiles).length > 0)) {return false;}
    for (const [name, profile] of Object.entries(value.profiles)) {
        if (!value.selectedProfiles.includes(name)) {return false;}
        try {
            const validated = validateWorkflowEntityRules(profile);
            if (validated.name !== name) {return false;}
        } catch {return false;}
    }
    return true;
};
const isResolveBundle = (value: unknown): boolean => isRecord(value)
    && exactKeys(value, ['resolves', 'diagnostics'])
    && isDiagnosticArray(value.diagnostics)
    && (value.resolves === null || isRecord(value.resolves));
