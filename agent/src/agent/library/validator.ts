import {createDslEntityRulesResolver, createDslResolveResolver} from '../../automation/dsl/link';
import type {DslCheckpointProvider} from '../../automation/dsl/emit';
import {validateDslSource} from '../../automation/dsl/runtime';
import {validateDslCheckpointGraph} from '../../automation/dsl/validate';
import type {WorkspaceEntityRulesProvider} from '../../automation/snapshot/rules';
import type {Checkpoint} from '../../automation/runner/checkpoint';
import {
    buildEntityRuleExportIndex,
    workflowArtifactRevision,
    type Workflow,
    type WorkflowArtifact,
} from '../../automation/workflow';
import type {DslDiagnostic} from '../../program/dsl/diagnostics';
import {dependencyGraphForSource} from './dependency_graph';
import type {
    AssetValidationEvidence,
    LibraryAssetEvidenceDependency,
    LibraryAssetId,
} from './contracts';

export type AssetValidatorContext = Readonly<{
    workflow: Workflow;
    checkpointProvider: DslCheckpointProvider;
    entityRulesProvider: WorkspaceEntityRulesProvider;
}>;

export type AssetValidator = Readonly<{
    validate: (id: LibraryAssetId) => AssetValidationEvidence;
    evidence: (id: LibraryAssetId) => AssetValidationEvidence | null;
}>;

export const createAssetValidator = (context: () => AssetValidatorContext): AssetValidator => {
    const store = new Map<string, AssetValidationEvidence>();
    return {
        validate: (id) => {
            const evidence = validateAsset(id, context());
            store.set(evidenceKey(id), evidence);
            return evidence;
        },
        evidence: (id) => store.get(evidenceKey(id)) ?? null,
    };
};

const evidenceKey = (id: LibraryAssetId): string => `${id.kind}:${id.name}`;

const validateAsset = (
    id: LibraryAssetId,
    context: AssetValidatorContext,
): AssetValidationEvidence => {
    if (id.kind === 'automation') {
        return validateDslAsset(id, context, {allowFailureRoot: false});
    }
    if (id.kind === 'procedure') {
        return validateCheckpointAsset(id, context, {allowFailureRoot: false});
    }
    if (id.kind === 'recovery') {
        return validateCheckpointAsset(id, context, {allowFailureRoot: true});
    }
    if (id.kind === 'demonstration') {
        return validateDemonstration(id, context);
    }
    return validatePageKnowledge(id, context);
};

const validateDslAsset = (
    id: LibraryAssetId,
    context: AssetValidatorContext,
    options: {allowFailureRoot: boolean},
): AssetValidationEvidence => {
    const artifact = readArtifact(context.workflow, 'dsl', id.name);
    if (artifact?.kind !== 'dsl') {
        return brokenEvidence(id, null, [], [{code: 'ERR_ASSET_NOT_FOUND', message: 'automation not found'}]);
    }
    const revision = workflowArtifactRevision(artifact);
    const dependencies = dependencyGraphForSource({source: artifact.content, workflow: context.workflow});
    const sourceDiagnostics = validateDslSource(
        artifact.content,
        createDslEntityRulesResolver(context.entityRulesProvider),
        createDslResolveResolver(context.workflow),
        options,
    ).diagnostics;
    if (sourceDiagnostics.length > 0) {
        return brokenEvidence(id, revision, dependencies, sourceDiagnostics);
    }
    const checkpointDiagnostics = validateCheckpointClosure(artifact.content, context, []);
    if (checkpointDiagnostics.length > 0) {
        return brokenEvidence(id, revision, dependencies, checkpointDiagnostics);
    }
    return readyEvidence(id, revision, dependencies);
};

const validateCheckpointAsset = (
    id: LibraryAssetId,
    context: AssetValidatorContext,
    options: {allowFailureRoot: boolean},
): AssetValidationEvidence => {
    const artifact = readArtifact(context.workflow, 'checkpoint', id.name);
    if (artifact?.kind !== 'checkpoint') {
        return brokenEvidence(id, null, [], [{code: 'ERR_ASSET_NOT_FOUND', message: 'checkpoint not found'}]);
    }
    const revision = workflowArtifactRevision(artifact);
    const checkpointKind = artifact.checkpoint.kind ?? 'procedure';
    if (checkpointKind !== id.kind) {
        return brokenEvidence(id, revision, [], [{
            code: 'ERR_ASSET_KIND_MISMATCH',
            message: `artifact is ${checkpointKind}, not ${id.kind}`,
        }]);
    }
    if (artifact.bodyDsl === undefined) {
        return readyEvidence(id, revision, []);
    }
    const dependencies = dependencyGraphForSource({source: artifact.bodyDsl, workflow: context.workflow});
    const bodyDiagnostics = validateDslSource(
        artifact.bodyDsl,
        createDslEntityRulesResolver(context.entityRulesProvider),
        createDslResolveResolver(context.workflow, new Map([[artifact.name, artifact.stepResolves]])),
        options,
    ).diagnostics;
    if (bodyDiagnostics.length > 0) {
        return brokenEvidence(id, revision, dependencies, bodyDiagnostics);
    }
    const checkpointDiagnostics = validateCheckpointClosure(artifact.bodyDsl, context, [id.name]);
    if (checkpointDiagnostics.length > 0) {
        return brokenEvidence(id, revision, dependencies, checkpointDiagnostics);
    }
    return readyEvidence(id, revision, dependencies);
};

const validateCheckpointClosure = (
    source: string,
    context: AssetValidatorContext,
    callStack: string[],
): DslDiagnostic[] =>
    validateDslCheckpointGraph(source, context.checkpointProvider, {
        callStack,
        validateBody: ({checkpoint, source: bodySource, stepResolves}) => validateDslSource(
            bodySource,
            createDslEntityRulesResolver(context.entityRulesProvider),
            createDslResolveResolver(context.workflow, new Map([[checkpoint.id, stepResolves]])),
            {allowFailureRoot: isRecoveryCheckpoint(checkpoint)},
        ).diagnostics,
    });

const validateDemonstration = (
    id: LibraryAssetId,
    context: AssetValidatorContext,
): AssetValidationEvidence => {
    const artifact = readArtifact(context.workflow, 'recording', id.name);
    if (artifact?.kind !== 'recording') {
        return brokenEvidence(id, null, [], [{code: 'ERR_ASSET_NOT_FOUND', message: 'demonstration not found'}]);
    }
    const revision = workflowArtifactRevision(artifact);
    if (artifact.steps.length === 0) {
        return brokenEvidence(id, revision, [], [{
            code: 'ERR_DEMONSTRATION_NOT_REPLAYABLE',
            message: 'demonstration has no steps to replay',
        }]);
    }
    return readyEvidence(id, revision, []);
};

const validatePageKnowledge = (
    id: LibraryAssetId,
    context: AssetValidatorContext,
): AssetValidationEvidence => {
    const artifact = readArtifact(context.workflow, 'entity_rules', id.name);
    if (artifact?.kind !== 'entity_rules') {
        return brokenEvidence(id, null, [], [{code: 'ERR_ASSET_NOT_FOUND', message: 'page knowledge not found'}]);
    }
    const revision = workflowArtifactRevision(artifact);
    const resolution = buildEntityRuleExportIndex(artifact);
    if (!resolution.index) {
        return brokenEvidence(id, revision, [], resolution.diagnostics.map((diagnostic) => ({
            code: diagnostic.code,
            message: diagnostic.message,
        })));
    }
    return readyEvidence(id, revision, []);
};

const readArtifact = (
    workflow: Workflow,
    kind: WorkflowArtifact['kind'],
    name: string,
): WorkflowArtifact | null => {
    try {
        return workflow.get(name, {kind});
    } catch {
        return null;
    }
};

const isRecoveryCheckpoint = (checkpoint: Checkpoint): boolean =>
    checkpoint.kind === 'recovery'
    || (checkpoint.kind === undefined && (checkpoint.trigger?.matchRules.length ?? 0) > 0);

const readyEvidence = (
    id: LibraryAssetId,
    assetRevision: string | null,
    dependencies: readonly LibraryAssetEvidenceDependency[],
): AssetValidationEvidence => evidenceFor(id, 'ready', assetRevision, dependencies, []);

const brokenEvidence = (
    id: LibraryAssetId,
    assetRevision: string | null,
    dependencies: readonly LibraryAssetEvidenceDependency[],
    diagnostics: readonly DslDiagnostic[],
): AssetValidationEvidence => evidenceFor(id, 'broken', assetRevision, dependencies, diagnostics);

const evidenceFor = (
    id: LibraryAssetId,
    outcome: 'ready' | 'broken',
    assetRevision: string | null,
    dependencies: readonly LibraryAssetEvidenceDependency[],
    diagnostics: readonly DslDiagnostic[],
): AssetValidationEvidence => Object.freeze({
    assetKind: id.kind,
    assetName: id.name,
    assetRevision,
    outcome,
    dependencies: Object.freeze(dependencies.map((dependency) => Object.freeze(dependency))),
    summary: Object.freeze(summarizeDiagnostics(diagnostics)),
    validatedAt: Date.now(),
});

const summarizeDiagnostics = (
    diagnostics: readonly DslDiagnostic[],
): {codes: readonly string[]; message: string} => ({
    codes: Object.freeze([...new Set(diagnostics.map((diagnostic) => diagnostic.code))].sort().slice(0, 20)),
    message: diagnostics[0]?.message ?? '',
});