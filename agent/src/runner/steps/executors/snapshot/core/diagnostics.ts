import type {
    EntityRuleDiagnostic,
    EntityRuleDiagnosticLevel,
    FinalEntityRecord,
} from './types';

export const createEntityRuleDiagnosticCollector = (initial: EntityRuleDiagnostic[] = []) => {
    const diagnostics = [...initial];
    return {
        add: (diagnostic: EntityRuleDiagnostic) => {
            diagnostics.push(diagnostic);
        },
        list: (): EntityRuleDiagnostic[] => dedupeEntityRuleDiagnostics(diagnostics),
    };
};

export const dedupeEntityRuleDiagnostics = (diagnostics: EntityRuleDiagnostic[]): EntityRuleDiagnostic[] => {
    const deduped = new Map<string, EntityRuleDiagnostic>();
    for (const diagnostic of diagnostics) {
        const key = [
            diagnostic.code,
            diagnostic.profile || '',
            diagnostic.ruleId || '',
            diagnostic.annotationId || '',
            diagnostic.entityId || '',
            diagnostic.businessTag || '',
            diagnostic.fieldKey || '',
            diagnostic.actionIntent || '',
            diagnostic.columnName || '',
            String(diagnostic.details?.value || ''),
        ].join('|');
        if (!deduped.has(key)) {
            deduped.set(key, diagnostic);
        }
    }
    return [...deduped.values()];
};

export const summarizeEntityRuleDiagnostics = (diagnostics: EntityRuleDiagnostic[]) => {
    const summary: Record<EntityRuleDiagnosticLevel, number> = {
        info: 0,
        warning: 0,
        error: 0,
    };
    for (const diagnostic of diagnostics) {
        summary[diagnostic.level] += 1;
    }
    return {
        total: diagnostics.length,
        byLevel: summary,
    };
};

export const filterEntityDiagnostics = (
    entity: Pick<FinalEntityRecord, 'id' | 'businessTag' | 'nodeId'>,
    diagnostics: EntityRuleDiagnostic[],
): EntityRuleDiagnostic[] =>
    diagnostics.filter(
        (diagnostic) =>
            diagnostic.entityId === entity.id ||
            diagnostic.businessTag === entity.businessTag ||
            Boolean(diagnostic.nodeIds?.includes(entity.nodeId)),
    );
