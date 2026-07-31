import crypto from 'node:crypto';
import type {WorkflowEntityRules} from './entity_rules';

export const entityRulesArtifactRevision = (profile: WorkflowEntityRules): string => {
    const canonical = JSON.stringify(canonicalize(profile));
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
