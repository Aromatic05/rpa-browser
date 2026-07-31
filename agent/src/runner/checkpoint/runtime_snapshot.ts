import { createDslEntityRulesResolver, type DslEntityRulesResolver, type DslResolveResolver } from '../../dsl/link';
import type { Workflow } from '../../workflow';
import type { WorkspaceEntityRulesProvider } from '../../snapshot/rules';
import type { StepResolve } from '../steps/types';
import type { DslCheckpointProvider } from '../../dsl/emit';
import type { Checkpoint } from './types';
import { scanDslAssetReferences } from '../../dsl/asset_references';

export type CheckpointRuntimeSnapshot = {
    provider: DslCheckpointProvider;
    checkpointStepResolves: Record<string, Record<string, StepResolve>>;
    checkpointBodies: Record<string, string>;
    entityRulesResolver?: DslEntityRulesResolver;
    resolveResolver?: DslResolveResolver;
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
    const checkpoints = new Map(options.checkpoints.map((checkpoint) => [checkpoint.id, cloneFrozen(checkpoint)]));
    const checkpointStepResolves = Object.fromEntries(Object.entries(options.checkpointStepResolves)
        .map(([id, resolves]) => [id, cloneFrozen(resolves)]));
    const checkpointBodies = cloneFrozen(options.checkpointBodies);
    const provider: DslCheckpointProvider = {
        getCheckpoint: (id) => checkpoints.get(id) ?? null,
        getCheckpointResolves: (id) => checkpointStepResolves[id] ?? null,
        getCheckpointBody: (id) => checkpointBodies[id] === undefined ? null : {source: checkpointBodies[id], stepResolves: checkpointStepResolves[id] ?? {}},
        listCheckpoints: () => [...checkpoints.values()],
    };
    const references = collectAssetReferences(options.assetSources || Object.values(checkpointBodies));
    const entityRulesResolver = options.entityRulesProvider
        ? materializeEntityRulesResolver(options.entityRulesProvider, references.entityRuleProfiles)
        : undefined;
    const resolveResolver = options.workflow ? materializeResolveResolver(options.workflow, references.resolveBundles) : undefined;
    return {provider, checkpointStepResolves, checkpointBodies, entityRulesResolver, resolveResolver};
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

    return materializeCheckpointRuntimeSnapshot({
        checkpoints: [...checkpoints.values()], checkpointStepResolves: stepResolves, checkpointBodies: bodies,
        workflow: options.workflow, entityRulesProvider: options.entityRulesProvider,
        assetSources: [...visitedSources],
    });
};

const materializeEntityRulesResolver = (
    provider: WorkspaceEntityRulesProvider,
    profileNames: ReadonlySet<string>,
): DslEntityRulesResolver => {
    const resolutions = new Map([...profileNames].map((name) => [name, cloneFrozen(provider.resolveExports(name))]));
    return createDslEntityRulesResolver({
        availability: 'ready', workflowName: provider.workflowName,
        listProfiles: () => [...resolutions.keys()], getProfile: () => null,
        resolveExports: (name) => resolutions.get(name) ?? {index: null, diagnostics: [{code: 'entity_rule_exports.profile_not_found', message: `profile not found: ${name}`}]},
    });
};

const materializeResolveResolver = (workflow: Workflow, bundleNames: ReadonlySet<string>): DslResolveResolver => {
    const bundles = new Map([...bundleNames].flatMap((name) => {
        const artifact = workflow.get(name, {kind: 'dsl'});
        return artifact?.kind === 'dsl' ? [[name, cloneFrozen(artifact.stepResolves ?? {})] as const] : [];
    }));
    return {resolveBundle: (name) => ({resolves: bundles.get(name) ?? null, diagnostics: []})};
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
