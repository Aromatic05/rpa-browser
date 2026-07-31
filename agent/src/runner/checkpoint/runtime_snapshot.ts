import { createDslEntityRulesResolver, type DslEntityRulesResolver, type DslResolveResolver } from '../../dsl/link';
import type { Workflow } from '../../workflow';
import type { WorkspaceEntityRulesProvider } from '../../snapshot/rules';
import type { StepResolve } from '../steps/types';
import type { DslCheckpointProvider } from '../../dsl/emit';
import type { Checkpoint } from './types';

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
    const entityRulesResolver = options.entityRulesProvider
        ? materializeEntityRulesResolver(options.entityRulesProvider)
        : undefined;
    const resolveResolver = options.workflow ? materializeResolveResolver(options.workflow) : undefined;
    return {provider, checkpointStepResolves, checkpointBodies, entityRulesResolver, resolveResolver};
};

const materializeEntityRulesResolver = (provider: WorkspaceEntityRulesProvider): DslEntityRulesResolver => {
    const resolutions = new Map(provider.listProfiles().map((name) => [name, cloneFrozen(provider.resolveExports(name))]));
    return createDslEntityRulesResolver({
        availability: 'ready', workflowName: provider.workflowName,
        listProfiles: () => [...resolutions.keys()], getProfile: () => null,
        resolveExports: (name) => resolutions.get(name) ?? {index: null, diagnostics: [{code: 'entity_rule_exports.profile_not_found', message: `profile not found: ${name}`}]},
    });
};

const materializeResolveResolver = (workflow: Workflow): DslResolveResolver => {
    const bundles = new Map(workflow.list({kind: 'dsl'}).flatMap((item) => {
        const artifact = workflow.get(item.name, {kind: 'dsl'});
        return artifact?.kind === 'dsl' ? [[item.name, cloneFrozen(artifact.stepResolves ?? {})] as const] : [];
    }));
    return {resolveBundle: (name) => ({resolves: bundles.get(name) ?? null, diagnostics: []})};
};
