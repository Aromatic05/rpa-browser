import type { EntityRuleQueryBinding } from '../query/contracts';
import type {
    BuildSemanticLayerInput,
    SemanticAnnotationRecord,
    SemanticBindingDiagnostic,
    SemanticBindingTarget,
    SemanticBusinessBinding,
    SemanticLayer,
} from './contracts';
import {buildSemanticBindingIndexes, cloneSemanticAnnotation} from './shared';
import {collectSemanticSuggestions} from './suggestions';

const PROTECTED_INFERRED_KEYS = new Set(['fieldKey', 'actionIntent', 'primaryKey']);

const findProtectedKeys = (value: unknown, found = new Set<string>()): Set<string> => {
    if (Array.isArray(value)) {
        for (const item of value) {findProtectedKeys(item, found);}
        return found;
    }
    if (!value || typeof value !== 'object') {return found;}
    for (const [key, item] of Object.entries(value)) {
        if (PROTECTED_INFERRED_KEYS.has(key)) {found.add(key);}
        findProtectedKeys(item, found);
    }
    return found;
};

const targetFromBinding = (binding: EntityRuleQueryBinding): SemanticBindingTarget => ({
    componentIds: [...binding.matchedComponentIds],
    nodeIds: [...binding.matchedNodeIds],
    fieldIds: [...binding.matchedFieldIds],
    actionIds: [...binding.matchedActionIds],
    rowIds: [...binding.matchedRowIds],
    columnIds: [...binding.matchedColumnIds],
});

const invalidProtectedKeyDiagnostic = (
    binding: SemanticBusinessBinding,
    protectedKeys: readonly string[],
): SemanticBindingDiagnostic => ({
    code: 'semantic-binding.inferred.protected-key',
    severity: 'error',
    stage: 'semantic-binding',
    status: 'rejected',
    nodeIds: [...binding.target.nodeIds],
    evidence: [],
    bindingId: binding.id,
    ruleId: binding.ruleId,
    message: `Inferred binding ${binding.id} cannot persist protected business keys: ${protectedKeys.join(', ')}.`,
});

const missingRuleDiagnostic = (
    profileName: string,
    annotation: SemanticAnnotationRecord,
): SemanticBindingDiagnostic => ({
    code: 'semantic-binding.rule.missing',
    severity: 'error',
    stage: 'semantic-binding',
    status: 'rejected',
    nodeIds: [],
    evidence: [],
    bindingId: `${profileName}:${annotation.ruleId}`,
    ruleId: annotation.ruleId,
    message: `Annotation ${profileName}:${annotation.ruleId} has no query binding.`,
});

export const createEmptySemanticLayer = (): SemanticLayer => ({
    bindings: buildSemanticBindingIndexes([]),
    suggestions: {items: [], diagnostics: []},
});

export const buildSemanticLayer = (input: BuildSemanticLayerInput): SemanticLayer => {
    const bindings: SemanticBusinessBinding[] = [];
    const diagnostics: SemanticBindingDiagnostic[] = input.execution.diagnostics.map((item) => ({...item}));
    const queryBindings = new Map(Object.entries(input.execution.byRuleId));

    for (const sourceAnnotation of input.annotations) {
        const annotation = cloneSemanticAnnotation(sourceAnnotation);
        const queryBinding = queryBindings.get(annotation.ruleId);
        if (!queryBinding) {
            diagnostics.push(missingRuleDiagnostic(input.execution.profileName, annotation));
            continue;
        }
        const origin = annotation.origin === 'manual' || annotation.origin === 'inferred'
            ? annotation.origin
            : 'confirmed';
        const disposition = annotation.disposition === 'ignored' ? 'ignored' : 'active';
        const binding: SemanticBusinessBinding = {
            id: `${input.execution.profileName}:${annotation.ruleId}`,
            profileName: input.execution.profileName,
            ruleId: annotation.ruleId,
            planStepId: queryBinding.planStepId,
            domain: queryBinding.domain,
            targetKind: queryBinding.targetKind,
            origin,
            disposition,
            status: queryBinding.ok || disposition === 'ignored' ? 'active' : 'invalidated',
            annotation,
            target: targetFromBinding(queryBinding),
        };
        const protectedKeys = origin === 'inferred' ? [...findProtectedKeys(annotation)] : [];
        if (protectedKeys.length > 0) {
            binding.status = 'invalidated';
            diagnostics.push(invalidProtectedKeyDiagnostic(binding, protectedKeys));
        }
        bindings.push(binding);
    }

    return {
        bindings: buildSemanticBindingIndexes(bindings, diagnostics),
        suggestions: collectSemanticSuggestions(input.snapshots),
    };
};
