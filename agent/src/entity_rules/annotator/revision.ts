import crypto from 'node:crypto';
import type { WorkflowEntityRules } from '../../workflow/entity_rules';

export type RevisionInput = Pick<WorkflowEntityRules, 'kind' | 'name' | 'match' | 'annotation'>;

const canonicalJson = (value: unknown): string => {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
        .join(',')}}`;
};

export const computeArtifactRevision = (artifact: RevisionInput): string =>
    crypto.createHash('sha256').update(canonicalJson(artifact)).digest('hex');

export const isRevisionConflict = (
    currentStored: WorkflowEntityRules | null,
    expectedRevision: string | null | undefined,
): boolean => {
    if (expectedRevision === null || expectedRevision === undefined) {
        return false;
    }
    const currentRevision = currentStored ? computeArtifactRevision(currentStored) : null;
    return currentRevision !== expectedRevision;
};
