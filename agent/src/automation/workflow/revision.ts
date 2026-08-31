import crypto from 'node:crypto';
import type {WorkflowCheckpoint} from './checkpoint';
import type {WorkflowDsl} from './dsl';
import type {WorkflowEntityRules} from './entity_rules';
import type {WorkflowRecording} from './recording';

type WorkflowRevisionArtifact = WorkflowRecording | WorkflowCheckpoint | WorkflowDsl | WorkflowEntityRules;

export const entityRulesArtifactRevision = (profile: WorkflowEntityRules): string =>
    revisionFor({
        kind: profile.kind,
        name: profile.name,
        page: profile.page,
        match: profile.match,
        annotation: profile.annotation,
    });

export const workflowArtifactRevision = (artifact: WorkflowRevisionArtifact): string => {
    if (artifact.kind === 'dsl') {
        return revisionFor({
            kind: artifact.kind,
            name: artifact.name,
            content: artifact.content,
            stepResolves: artifact.stepResolves,
        });
    }
    if (artifact.kind === 'checkpoint') {
        return revisionFor({
            kind: artifact.kind,
            name: artifact.name,
            checkpoint: artifact.checkpoint,
            stepResolves: artifact.stepResolves,
            hints: artifact.hints,
            bodyDsl: artifact.bodyDsl,
        });
    }
    if (artifact.kind === 'recording') {
        return revisionFor({
            kind: artifact.kind,
            name: artifact.name,
            recording: artifact.recording,
            steps: artifact.steps,
            stepResolves: artifact.stepResolves,
        });
    }
    return entityRulesArtifactRevision(artifact);
};

const revisionFor = (value: unknown): string => {
    const canonical = JSON.stringify(canonicalize(value));
    return `sha256:${crypto.createHash('sha256').update(canonical).digest('hex')}`;
};

const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) {return value.map(canonicalize);}
    if (!value || typeof value !== 'object') {return value;}
    return Object.fromEntries(
        Object.entries(value)
            .filter(([, item]) => item !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, canonicalize(item)]),
    );
};
