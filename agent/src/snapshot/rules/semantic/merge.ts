import type {
    SemanticBindingDiagnostic,
    SemanticBindingMergeResult,
    SemanticBusinessBinding,
    SemanticBindings,
} from './contracts';
import {
    buildSemanticBindingIndexes,
    cloneSemanticAnnotation,
    cloneSemanticTarget,
    semanticTargetsEqual,
} from './shared';

const cloneBinding = (binding: SemanticBusinessBinding): SemanticBusinessBinding => ({
    ...binding,
    annotation: cloneSemanticAnnotation(binding.annotation),
    target: cloneSemanticTarget(binding.target),
});

const invalidatedTargetDiagnostic = (binding: SemanticBusinessBinding): SemanticBindingDiagnostic => ({
    code: 'semantic-binding.target.invalidated',
    severity: 'error',
    stage: 'semantic-binding-merge',
    status: 'rejected',
    nodeIds: [...binding.target.nodeIds],
    evidence: [],
    bindingId: binding.id,
    ruleId: binding.ruleId,
    message: `Protected semantic binding ${binding.id} no longer resolves to its confirmed target.`,
});

const semanticTargetEmpty = (binding: SemanticBusinessBinding): boolean =>
    binding.target.componentIds.length === 0
    && binding.target.nodeIds.length === 0
    && binding.target.fieldIds.length === 0
    && binding.target.actionIds.length === 0
    && binding.target.rowIds.length === 0
    && binding.target.columnIds.length === 0;

export const mergeSemanticBindings = (
    existing: SemanticBindings,
    fresh: SemanticBindings,
): SemanticBindingMergeResult => {
    const merged: SemanticBusinessBinding[] = [];
    const diagnostics: SemanticBindingDiagnostic[] = [
        ...existing.diagnostics.map((item) => ({...item})),
        ...fresh.diagnostics.map((item) => ({...item})),
    ];
    const stats = {added: 0, refreshed: 0, preserved: 0, invalidated: 0};
    const consumed = new Set<string>();
    const freshById = new Map(Object.entries(fresh.byId));

    for (const current of Object.values(existing.byId)) {
        const next = freshById.get(current.id);
        if (next) {consumed.add(next.id);}

        if (current.disposition === 'ignored') {
            merged.push(cloneBinding(current));
            stats.preserved += 1;
            continue;
        }

        if (current.origin === 'confirmed'
            && current.status === 'invalidated'
            && semanticTargetEmpty(current)
            && next?.status === 'active') {
            const reactivated = cloneBinding(next);
            reactivated.annotation = cloneSemanticAnnotation(current.annotation);
            reactivated.origin = 'confirmed';
            reactivated.disposition = current.disposition;
            merged.push(reactivated);
            stats.refreshed += 1;
            continue;
        }

        if (current.origin === 'manual' || current.origin === 'confirmed') {
            const preserved = cloneBinding(current);
            if (next?.status !== 'active' || !semanticTargetsEqual(current.target, next.target)) {
                preserved.status = 'invalidated';
                diagnostics.push(invalidatedTargetDiagnostic(preserved));
                stats.invalidated += 1;
            } else {
                preserved.status = 'active';
                stats.preserved += 1;
            }
            merged.push(preserved);
            continue;
        }

        if (next) {
            const refreshed = cloneBinding(next);
            refreshed.annotation = cloneSemanticAnnotation(current.annotation);
            refreshed.origin = 'inferred';
            refreshed.disposition = current.disposition;
            merged.push(refreshed);
            stats.refreshed += 1;
        } else {
            const missing = cloneBinding(current);
            missing.status = 'invalidated';
            merged.push(missing);
            stats.invalidated += 1;
        }
    }

    for (const next of Object.values(fresh.byId)) {
        if (consumed.has(next.id)) {continue;}
        merged.push(cloneBinding(next));
        stats.added += 1;
    }

    return {bindings: buildSemanticBindingIndexes(merged, diagnostics), stats};
};
