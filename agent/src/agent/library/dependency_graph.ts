import {scanDslAssetReferences} from '../../program/dsl/asset_references';
import {
    workflowArtifactRevision,
    type Workflow,
    type WorkflowArtifact,
} from '../../automation/workflow';
import type {LibraryAssetEvidenceDependency} from './contracts';

export const dependencyGraphForSource = (options: {
    source: string;
    workflow: Workflow;
}): readonly LibraryAssetEvidenceDependency[] => {
    let references;
    try {
        references = scanDslAssetReferences(options.source);
    } catch {
        return Object.freeze([]);
    }
    const dependencies: LibraryAssetEvidenceDependency[] = [];
    for (const checkpointId of [...references.checkpoints].sort()) {
        const artifact = readArtifact(options.workflow, 'checkpoint', checkpointId);
        const kind = artifact?.kind === 'checkpoint' && artifact.checkpoint.kind === 'recovery'
            ? 'recovery'
            : 'procedure';
        dependencies.push(Object.freeze({
            kind,
            name: checkpointId,
            revision: artifact?.kind === 'checkpoint' ? workflowArtifactRevision(artifact) : null,
        }));
    }
    for (const profileName of [...references.entityRuleProfiles].sort()) {
        const artifact = readArtifact(options.workflow, 'entity_rules', profileName);
        dependencies.push(Object.freeze({
            kind: 'page_knowledge',
            name: profileName,
            revision: artifact?.kind === 'entity_rules' ? workflowArtifactRevision(artifact) : null,
        }));
    }
    return Object.freeze(dependencies);
};

const readArtifact = (
    workflow: Workflow,
    kind: WorkflowArtifact['kind'],
    name: string,
): ReturnType<Workflow['get']> => {
    try {
        return workflow.get(name, {kind});
    } catch {
        return null;
    }
};