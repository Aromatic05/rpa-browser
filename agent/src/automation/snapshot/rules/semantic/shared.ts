import type { ObservationNodeId } from '../../observation/model/contracts';
import type {
    SemanticAnnotationRecord,
    SemanticBindingDiagnostic,
    SemanticBindingTarget,
    SemanticBusinessBinding,
    SemanticBindings,
} from './contracts';

const bindingPriority = (binding: SemanticBusinessBinding): number => {
    if (binding.origin === 'manual') {return 3;}
    if (binding.origin === 'confirmed') {return 2;}
    return 1;
};

const append = <T extends string>(
    index: Record<T, SemanticBusinessBinding[] | undefined>,
    key: T,
    binding: SemanticBusinessBinding,
): void => {
    const current = index[key] || [];
    index[key] = [...current, binding];
};

const componentDiagnostic = (
    componentId: string,
    existing: SemanticBusinessBinding,
    candidate: SemanticBusinessBinding,
): SemanticBindingDiagnostic => ({
    code: 'semantic-binding.component.conflict',
    severity: 'warning',
    stage: 'semantic-binding',
    nodeIds: [...new Set([...existing.target.nodeIds, ...candidate.target.nodeIds])],
    evidence: [],
    bindingId: candidate.id,
    ruleId: candidate.ruleId,
    message: `Component ${componentId} has competing semantic bindings ${existing.id} and ${candidate.id}.`,
});

const indexComponent = (
    index: Record<string, SemanticBusinessBinding | undefined>,
    componentId: string,
    binding: SemanticBusinessBinding,
    diagnostics: SemanticBindingDiagnostic[],
): void => {
    const existing = index[componentId];
    if (!existing) {
        index[componentId] = binding;
        return;
    }
    const existingPriority = bindingPriority(existing);
    const candidatePriority = bindingPriority(binding);
    if (candidatePriority > existingPriority) {
        index[componentId] = binding;
        return;
    }
    if (candidatePriority === existingPriority && existing.id !== binding.id) {
        diagnostics.push(componentDiagnostic(componentId, existing, binding));
    }
};

export const buildSemanticBindingIndexes = (
    bindings: readonly SemanticBusinessBinding[],
    diagnostics: readonly SemanticBindingDiagnostic[] = [],
): SemanticBindings => {
    const byId: Record<string, SemanticBusinessBinding> = {};
    const forms: Record<string, SemanticBusinessBinding | undefined> = {};
    const tables: Record<string, SemanticBusinessBinding | undefined> = {};
    const nodes: Record<ObservationNodeId, SemanticBusinessBinding[] | undefined> = {};
    const fields: Record<string, SemanticBusinessBinding[] | undefined> = {};
    const actions: Record<string, SemanticBusinessBinding[] | undefined> = {};
    const rows: Record<string, SemanticBusinessBinding[] | undefined> = {};
    const columns: Record<string, SemanticBusinessBinding[] | undefined> = {};
    const nextDiagnostics = [...diagnostics];

    for (const binding of bindings) {
        byId[binding.id] = binding;
        if (binding.status !== 'active' || binding.disposition === 'ignored') {continue;}
        for (const componentId of binding.target.componentIds) {
            if (binding.domain === 'form' && binding.targetKind === 'form-component') {
                indexComponent(forms, componentId, binding, nextDiagnostics);
            }
            if (binding.domain === 'table' && binding.targetKind === 'table-component') {
                indexComponent(tables, componentId, binding, nextDiagnostics);
            }
        }
        for (const nodeId of binding.target.nodeIds) {append(nodes, nodeId, binding);}
        for (const fieldId of binding.target.fieldIds) {append(fields, fieldId, binding);}
        for (const actionId of binding.target.actionIds) {append(actions, actionId, binding);}
        for (const rowId of binding.target.rowIds) {append(rows, rowId, binding);}
        for (const columnId of binding.target.columnIds) {append(columns, columnId, binding);}
    }

    return {byId, forms, tables, nodes, fields, actions, rows, columns, diagnostics: nextDiagnostics};
};

export const cloneSemanticTarget = (target: SemanticBindingTarget): SemanticBindingTarget => ({
    componentIds: [...target.componentIds],
    nodeIds: [...target.nodeIds],
    fieldIds: [...target.fieldIds],
    actionIds: [...target.actionIds],
    rowIds: [...target.rowIds],
    columnIds: [...target.columnIds],
});

export const semanticTargetsEqual = (left: SemanticBindingTarget, right: SemanticBindingTarget): boolean =>
    JSON.stringify(left) === JSON.stringify(right);
export const cloneSemanticAnnotation = (annotation: SemanticAnnotationRecord): SemanticAnnotationRecord => {
    const cloneValue = (value: unknown): unknown => {
        if (Array.isArray(value)) {return value.map(cloneValue);}
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
        }
        return value;
    };
    return cloneValue(annotation) as SemanticAnnotationRecord;
};
