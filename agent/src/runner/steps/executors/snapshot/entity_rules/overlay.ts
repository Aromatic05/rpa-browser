import type { EntityBusinessInfo } from '../core/types';
import type { BusinessEntityOverlay, NodeBusinessHint } from './types';

export const createEmptyBusinessEntityOverlay = (): BusinessEntityOverlay => ({
    byRuleId: {},
    byEntityId: {},
    nodeHintsByNodeId: {},
});

export const mergeEntityBusinessInfo = (
    base: EntityBusinessInfo | undefined,
    patch: EntityBusinessInfo | undefined,
): EntityBusinessInfo | undefined => {
    if (!base && !patch) {return undefined;}
    return {
        businessTag: patch?.businessTag ?? base?.businessTag,
        businessName: patch?.businessName ?? base?.businessName,
        primaryKey: patch?.primaryKey
            ? {
                fieldKey: patch.primaryKey.fieldKey,
                columns: patch.primaryKey.columns ? [...patch.primaryKey.columns] : undefined,
                source: patch.primaryKey.source,
            }
            : base?.primaryKey
              ? {
                  fieldKey: base.primaryKey.fieldKey,
                  columns: base.primaryKey.columns ? [...base.primaryKey.columns] : undefined,
                  source: base.primaryKey.source,
              }
              : undefined,
        columns: patch?.columns
            ? patch.columns.map((column: NonNullable<EntityBusinessInfo['columns']>[number]) => ({ ...column }))
            : base?.columns
              ? base.columns.map((column: NonNullable<EntityBusinessInfo['columns']>[number]) => ({ ...column }))
              : undefined,
        formFields: patch?.formFields
            ? patch.formFields.map((field: NonNullable<EntityBusinessInfo['formFields']>[number]) => ({
                ...field,
                optionSource: field.optionSource ? { ...field.optionSource } : undefined,
            }))
            : base?.formFields
              ? base.formFields.map((field: NonNullable<EntityBusinessInfo['formFields']>[number]) => ({
                  ...field,
                  optionSource: field.optionSource ? { ...field.optionSource } : undefined,
              }))
              : undefined,
        formActions: patch?.formActions
            ? patch.formActions.map((action: NonNullable<EntityBusinessInfo['formActions']>[number]) => ({ ...action }))
            : base?.formActions
              ? base.formActions.map((action: NonNullable<EntityBusinessInfo['formActions']>[number]) => ({ ...action }))
              : undefined,
        tableMeta: patch?.tableMeta
            ? {
                rowCount: patch.tableMeta.rowCount,
                columnCount: patch.tableMeta.columnCount,
                headers: [...patch.tableMeta.headers],
                rowNodeIds: [...patch.tableMeta.rowNodeIds],
                cellNodeIdsByRowNodeId: { ...patch.tableMeta.cellNodeIdsByRowNodeId },
                columnCellNodeIdsByHeader: { ...patch.tableMeta.columnCellNodeIdsByHeader },
                primaryKeyCandidates: patch.tableMeta.primaryKeyCandidates.map((item) => ({ ...item, columns: [...item.columns] })),
                recommendedPrimaryKey: patch.tableMeta.recommendedPrimaryKey ? [...patch.tableMeta.recommendedPrimaryKey] : undefined,
            }
            : base?.tableMeta
              ? {
                  rowCount: base.tableMeta.rowCount,
                  columnCount: base.tableMeta.columnCount,
                  headers: [...base.tableMeta.headers],
                  rowNodeIds: [...base.tableMeta.rowNodeIds],
                  cellNodeIdsByRowNodeId: { ...base.tableMeta.cellNodeIdsByRowNodeId },
                  columnCellNodeIdsByHeader: { ...base.tableMeta.columnCellNodeIdsByHeader },
                  primaryKeyCandidates: base.tableMeta.primaryKeyCandidates.map((item) => ({ ...item, columns: [...item.columns] })),
                  recommendedPrimaryKey: base.tableMeta.recommendedPrimaryKey ? [...base.tableMeta.recommendedPrimaryKey] : undefined,
              }
              : undefined,
    };
};

export const mergeNodeBusinessHint = (
    base: NodeBusinessHint | undefined,
    patch: NodeBusinessHint | undefined,
): NodeBusinessHint | undefined => {
    if (!base && !patch) {return undefined;}
    return {
        entityNodeId: patch?.entityNodeId ?? base?.entityNodeId,
        entityKind: patch?.entityKind ?? base?.entityKind,
        fieldKey: patch?.fieldKey ?? base?.fieldKey,
        fieldRole: patch?.fieldRole ?? base?.fieldRole,
        controlKind: patch?.controlKind ?? base?.controlKind,
        actionIntent: patch?.actionIntent ?? base?.actionIntent,
    };
};
