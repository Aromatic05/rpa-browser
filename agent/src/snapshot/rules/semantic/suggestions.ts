import type { SemanticSuggestion } from '../../components/shared/contracts';
import type { QueryPlanSnapshots } from '../query/contracts';
import type { SemanticSuggestionRecord, SemanticSuggestions } from './contracts';

const appendSuggestion = (
    items: SemanticSuggestionRecord[],
    input: {
        domain: 'form' | 'table';
        targetKind: SemanticSuggestionRecord['targetKind'];
        componentId: string;
        nodeId?: string;
        memberId?: string;
        suggestion: SemanticSuggestion;
    },
): void => {
    const index = items.length;
    items.push({
        id: `${input.domain}:${input.componentId}:${input.memberId || 'component'}:${input.suggestion.kind}:${index}`,
        domain: input.domain,
        targetKind: input.targetKind,
        componentId: input.componentId,
        nodeId: input.nodeId,
        memberId: input.memberId,
        kind: input.suggestion.kind,
        value: input.suggestion.value,
        source: 'inferred',
        evidence: input.suggestion.evidence.map((item) => ({...item, nodeIds: [...item.nodeIds]})),
    });
};

export const collectSemanticSuggestions = (snapshots: QueryPlanSnapshots): SemanticSuggestions => {
    const items: SemanticSuggestionRecord[] = [];
    if (snapshots.form) {
        for (const form of Object.values(snapshots.form.forms.forms)) {
            for (const suggestion of form.suggestions) {
                appendSuggestion(items, {
                    domain: 'form',
                    targetKind: 'form-component',
                    componentId: form.id,
                    nodeId: form.location.structuralRootNodeId,
                    suggestion,
                });
            }
            for (const action of form.actions) {
                for (const suggestion of action.suggestions) {
                    appendSuggestion(items, {
                        domain: 'form',
                        targetKind: 'form-action',
                        componentId: form.id,
                        nodeId: action.nodeId,
                        memberId: action.id,
                        suggestion,
                    });
                }
            }
        }
    }
    if (snapshots.table) {
        for (const table of Object.values(snapshots.table.tables.tables)) {
            for (const suggestion of table.suggestions) {
                appendSuggestion(items, {
                    domain: 'table',
                    targetKind: 'table-component',
                    componentId: table.id,
                    nodeId: table.location.structuralRootNodeId,
                    suggestion,
                });
            }
        }
    }
    return {items, diagnostics: []};
};
