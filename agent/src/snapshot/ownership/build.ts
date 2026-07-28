import type { AnalysisDiagnostic } from '../observation/contracts';
import { deepFreeze } from '../observation/freeze';
import type {
    OwnershipEdge,
    OwnershipEndpoint,
    OwnershipIndex,
    OwnershipValidation,
} from './contracts';

export const ownershipEndpointKey = (endpoint: OwnershipEndpoint): string =>
    `${endpoint.kind}:${endpoint.id}`;

export const buildOwnershipIndex = (edges: readonly OwnershipEdge[]): OwnershipIndex => {
    const mutableEdges = edges.map((edge) => ({
        ...edge,
        owner: { ...edge.owner },
        member: { ...edge.member },
        evidence: [...edge.evidence],
    }));
    const byOwner: Record<string, number[]> = {};
    const byMember: Record<string, number[]> = {};
    mutableEdges.forEach((edge, index) => {
        (byOwner[ownershipEndpointKey(edge.owner)] ??= []).push(index);
        (byMember[ownershipEndpointKey(edge.member)] ??= []).push(index);
    });
    const validation = validateOwnershipIndex(mutableEdges);
    return deepFreeze({
        edges: mutableEdges,
        byOwner,
        byMember,
        diagnostics: validation.diagnostics,
        validation,
    });
};

export const validateOwnershipIndex = (edges: readonly OwnershipEdge[]): OwnershipValidation => {
    const diagnostics: AnalysisDiagnostic[] = [];
    const seen = new Map<string, OwnershipEdge[]>();
    for (const edge of edges) {
        const key = `${ownershipEndpointKey(edge.member)}|${edge.owner.kind}|${edge.role}`;
        const bucket = seen.get(key) ?? [];
        bucket.push(edge);
        seen.set(key, bucket);
    }
    for (const [key, bucket] of seen) {
        const ownerKeys = new Set(bucket.map((edge) => ownershipEndpointKey(edge.owner)));
        if (bucket.length < 2) {continue;}
        diagnostics.push({
            code: 'ownership.role.duplicate',
            severity: 'error',
            stage: 'ownership',
            status: 'ambiguous',
            nodeIds: [],
            evidence: bucket.flatMap((edge) => edge.evidence),
            message: ownerKeys.size > 1
                ? `ownership role has multiple owners: ${key}`
                : `ownership role is duplicated: ${key}`,
        });
    }
    return deepFreeze({ ok: diagnostics.length === 0, diagnostics });
};
