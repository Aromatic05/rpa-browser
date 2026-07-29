import type {
    AnnotatorDiagnostic,
    AnnotatorDraft,
    AnnotatorValidation,
} from '../../snapshot/annotator';
import {
    buildSemanticLayer,
    compileEntityRuleQueryPlan,
    executeEntityRuleQueryPlan,
    type PageSnapshotSessionEntry,
    type SemanticBindings,
    type SemanticLayer,
    type SemanticSuggestions,
} from '../../snapshot';
import {
    validateWorkflowEntityRules,
    type WorkflowEntityRules,
} from '../../workflow';

export type AnnotatorDraftEvaluation = {
    profile?: WorkflowEntityRules;
    validation: AnnotatorValidation;
    semanticLayer?: SemanticLayer;
};

export const evaluateAnnotatorDraft = (
    entry: PageSnapshotSessionEntry,
    draft: AnnotatorDraft,
    purpose: 'check' | 'save',
): AnnotatorDraftEvaluation => {
    let profile: WorkflowEntityRules;
    try {
        profile = validateWorkflowEntityRules({
            kind: 'entity_rules',
            name: draft.profileName,
            match: draft.match,
            annotation: draft.annotation,
        });
    } catch (error) {
        return invalidEvaluation('annotator.artifact.invalid', errorMessage(error));
    }

    const compiled = compileEntityRuleQueryPlan({
        profileName: profile.name,
        rules: profile.match.rules,
    });
    if (!compiled.ok) {
        return {
            profile,
            validation: {
                ok: false,
                diagnostics: compiled.diagnostics.map(toAnnotatorDiagnostic),
                bindingIds: [],
                suggestionIds: [],
            },
        };
    }

    const snapshots = compiled.plan.domain === 'form'
        ? {form: entry.capture.form}
        : {table: entry.capture.table};
    const execution = executeEntityRuleQueryPlan(compiled.plan, snapshots, {purpose});
    const semanticLayer = buildSemanticLayer({
        execution,
        annotations: profile.annotation.bindings,
        snapshots,
    });
    const diagnostics = dedupeDiagnostics([
        ...execution.diagnostics.map(toAnnotatorDiagnostic),
        ...semanticLayer.bindings.diagnostics.map(toAnnotatorDiagnostic),
        ...semanticLayer.suggestions.diagnostics.map(toAnnotatorDiagnostic),
    ]);
    const invalidBinding = Object.values(semanticLayer.bindings.byId).some((binding) =>
        binding.disposition === 'active' && binding.status === 'invalidated');
    return {
        profile,
        semanticLayer,
        validation: {
            ok: execution.ok && !invalidBinding && diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
            domain: compiled.plan.domain,
            diagnostics,
            bindingIds: Object.keys(semanticLayer.bindings.byId).sort(),
            suggestionIds: semanticLayer.suggestions.items.map((item) => item.id).sort(),
        },
    };
};

export const projectAnnotatorEvaluation = (
    entry: PageSnapshotSessionEntry,
    evaluation: AnnotatorDraftEvaluation,
): PageSnapshotSessionEntry => {
    if (!evaluation.profile || !evaluation.semanticLayer) {return entry;}
    return {
        ...entry,
        semanticBindingsByProfile: {
            ...entry.semanticBindingsByProfile,
            [evaluation.profile.name]: evaluation.semanticLayer.bindings,
        },
        semanticSuggestionsByProfile: {
            ...entry.semanticSuggestionsByProfile,
            [evaluation.profile.name]: evaluation.semanticLayer.suggestions,
        },
    };
};

export const workflowProfileToAnnotatorDraft = (
    profile: WorkflowEntityRules,
): AnnotatorDraft => ({
    profileName: profile.name,
    match: structuredClone(profile.match),
    annotation: structuredClone(profile.annotation),
});

const invalidEvaluation = (code: string, message: string): AnnotatorDraftEvaluation => ({
    validation: {
        ok: false,
        diagnostics: [{code, severity: 'error', message, nodeIds: []}],
        bindingIds: [],
        suggestionIds: [],
    },
});

const toAnnotatorDiagnostic = (diagnostic: {
    code: string;
    severity: string;
    message: string;
    nodeIds: readonly string[];
    ruleId?: string;
    planStepId?: string;
}): AnnotatorDiagnostic => ({
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    nodeIds: [...diagnostic.nodeIds],
    ruleId: diagnostic.ruleId,
    planStepId: diagnostic.planStepId,
});

const dedupeDiagnostics = (diagnostics: readonly AnnotatorDiagnostic[]): AnnotatorDiagnostic[] => {
    const byKey = new Map<string, AnnotatorDiagnostic>();
    for (const diagnostic of diagnostics) {
        const key = [
            diagnostic.code,
            diagnostic.message,
            diagnostic.ruleId ?? '',
            diagnostic.planStepId ?? '',
            diagnostic.nodeIds.join(','),
        ].join('|');
        if (!byKey.has(key)) {byKey.set(key, diagnostic);}
    }
    return [...byKey.values()];
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export type AnnotatorSemanticProjection = {
    bindings: SemanticBindings;
    suggestions: SemanticSuggestions;
};
