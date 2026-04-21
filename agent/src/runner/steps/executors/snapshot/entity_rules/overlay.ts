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
    if (!base && !patch) return undefined;
    return {
        businessTag: patch?.businessTag ?? base?.businessTag,
        businessName: patch?.businessName ?? base?.businessName,
        primaryKey: patch?.primaryKey
            ? {
                fieldKey: patch.primaryKey.fieldKey,
                columns: patch.primaryKey.columns ? [...patch.primaryKey.columns] : undefined,
            }
            : base?.primaryKey
              ? {
                  fieldKey: base.primaryKey.fieldKey,
                  columns: base.primaryKey.columns ? [...base.primaryKey.columns] : undefined,
              }
              : undefined,
        columns: patch?.columns
            ? patch.columns.map((column: NonNullable<EntityBusinessInfo['columns']>[number]) => ({ ...column }))
            : base?.columns
              ? base.columns.map((column: NonNullable<EntityBusinessInfo['columns']>[number]) => ({ ...column }))
              : undefined,
    };
};

export const mergeNodeBusinessHint = (
    base: NodeBusinessHint | undefined,
    patch: NodeBusinessHint | undefined,
): NodeBusinessHint | undefined => {
    if (!base && !patch) return undefined;
    return {
        entityNodeId: patch?.entityNodeId ?? base?.entityNodeId,
        entityKind: patch?.entityKind ?? base?.entityKind,
        fieldKey: patch?.fieldKey ?? base?.fieldKey,
        actionIntent: patch?.actionIntent ?? base?.actionIntent,
    };
};
