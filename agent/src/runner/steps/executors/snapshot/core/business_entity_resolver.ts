import type { BrowserQueryResult } from '../../../types';
import { filterEntityDiagnostics } from './diagnostics';
import { queryTableHasNextPage, resolveTableNextPageTarget } from './pagination';
import { normalizeText } from './runtime_store';
import { buildTableStructureModel } from './table_model';
import { resolveTableRowAction, resolveTableRowByPrimaryKey } from './entity_query';
import type { EntityRuleDiagnostic, FinalEntityRecord, FinalEntityView, SnapshotResult } from './types';

export type ResolverError = {
    code: 'ERR_BAD_ARGS' | 'ERR_NOT_FOUND' | 'ERR_AMBIGUOUS' | 'ERR_UNRESOLVED_TARGET';
    message: string;
    details?: unknown;
};

export type ResolverResult<T> =
    | {
          ok: true;
          data: T;
      }
    | {
          ok: false;
          error: ResolverError;
      };

type ResolverDiagnosticDetails = {
    diagnostic: EntityRuleDiagnostic;
    relatedDiagnostics?: EntityRuleDiagnostic[];
};

export type BusinessEntityQuery =
    | 'table.rowCount'
    | 'table.headers'
    | 'table.primaryKey'
    | 'table.columns'
    | 'table.currentRows'
    | 'table.hasNextPage'
    | 'table.nextPageTarget'
    | 'form.fields'
    | 'form.actions';

export type BusinessEntityTarget =
    | {
          kind: 'form.field';
          fieldKey: string;
      }
    | {
          kind: 'form.action';
          actionIntent: string;
      }
    | {
          kind: 'table.row';
          primaryKey: {
              fieldKey: string;
              value: string;
          };
      }
    | {
          kind: 'table.row_action';
          primaryKey: {
              fieldKey: string;
              value: string;
          };
          actionIntent: string;
      };

export const resolveUniqueBusinessEntity = (
    finalEntityView: FinalEntityView,
    businessTagRaw: string | undefined,
): ResolverResult<FinalEntityRecord> => {
    const businessTag = normalizeText(businessTagRaw);
    if (!businessTag) {
        return {
            ok: false,
            error: {
                code: 'ERR_BAD_ARGS',
                message: 'businessTag is required',
            },
        };
    }

    const matched = finalEntityView.entities.filter((entity) => normalizeText(entity.businessTag) === businessTag);
    if (matched.length === 0) {
        return {
            ok: false,
            error: {
                code: 'ERR_NOT_FOUND',
                message: 'business entity not found',
                details: { businessTag },
            },
        };
    }
    if (matched.length > 1) {
        return {
            ok: false,
            error: {
                code: 'ERR_AMBIGUOUS',
                message: 'business entity is ambiguous',
                details: {
                    businessTag,
                    candidates: matched.map((entity) => ({
                        entityId: entity.id,
                        nodeId: entity.nodeId,
                        kind: entity.kind,
                        name: entity.name,
                    })),
                },
            },
        };
    }

    return {
        ok: true,
        data: matched[0],
    };
};

export const queryBusinessEntity = (
    snapshot: SnapshotResult,
    finalEntityView: FinalEntityView,
    businessTag: string | undefined,
    query: BusinessEntityQuery,
): ResolverResult<BrowserQueryResult> => {
    const resolved = resolveUniqueBusinessEntity(finalEntityView, businessTag);
    if (!resolved.ok) {return resolved;}
    const entity = resolved.data;

    if (query.startsWith('table.') && entity.kind !== 'table') {
        return {
            ok: false,
            error: {
                code: 'ERR_BAD_ARGS',
                message: 'table query requires table entity',
                details: { businessTag, entityKind: entity.kind, query },
            },
        };
    }
    if (query.startsWith('form.') && entity.kind !== 'form') {
        return {
            ok: false,
            error: {
                code: 'ERR_BAD_ARGS',
                message: 'form query requires form entity',
                details: { businessTag, entityKind: entity.kind, query },
            },
        };
    }

    const metaBase = {
        query,
        businessTag: entity.businessTag,
        entityId: entity.id,
        nodeId: entity.nodeId,
    };

    if (query === 'table.rowCount') {
        const model = entity.tableMeta ? null : buildTableStructureModel(snapshot, entity.nodeId);
        return {
            ok: true,
            data: {
                kind: 'value',
                value: entity.tableMeta?.rowCount ?? model?.rows.length ?? 0,
                meta: metaBase,
            },
        };
    }

    if (query === 'table.headers') {
        const model = entity.tableMeta ? null : buildTableStructureModel(snapshot, entity.nodeId);
        return {
            ok: true,
            data: {
                kind: 'value',
                value: entity.tableMeta?.headers || model?.headers || [],
                meta: metaBase,
            },
        };
    }

    if (query === 'table.primaryKey') {
        return {
            ok: true,
            data: {
                kind: 'value',
                value: entity.primaryKey
                    ? {
                          fieldKey: entity.primaryKey.fieldKey,
                          columns: entity.primaryKey.columns ? [...entity.primaryKey.columns] : undefined,
                          source: entity.primaryKey.source,
                      }
                    : undefined,
                meta: metaBase,
            },
        };
    }

    if (query === 'table.columns') {
        return {
            ok: true,
            data: {
                kind: 'value',
                value: (entity.columns || []).map((column) => ({
                    fieldKey: column.fieldKey,
                    name: column.name,
                    kind: column.kind,
                    source: column.source,
                    columnIndex: column.columnIndex,
                    headerNodeId: column.headerNodeId,
                    actions: column.actions?.map((action) => ({
                        actionIntent: action.actionIntent,
                        text: action.text,
                    })),
                })),
                meta: metaBase,
            },
        };
    }

    if (query === 'table.currentRows') {
        const model = buildTableStructureModel(snapshot, entity.nodeId);
        const rows = !model
            ? []
            : model.rows.map((row) => ({
                  rowNodeId: row.nodeId,
                  cells: row.cells.map((cell, columnIndex) => {
                      const mapped = mapFieldKeyByColumnIndex(entity, model.headers, columnIndex);
                      return {
                          fieldKey: mapped.fieldKey,
                          header: mapped.header,
                          text: cell.value,
                          cellNodeId: cell.nodeId,
                      };
                  }),
              }));

        return {
            ok: true,
            data: {
                kind: 'value',
                value: rows,
                meta: metaBase,
            },
        };
    }

    if (query === 'table.hasNextPage') {
        const pagination = queryTableHasNextPage(snapshot, entity);
        return {
            ok: true,
            data: {
                kind: 'value',
                value: pagination.hasNextPage,
                meta: {
                    ...metaBase,
                    targetNodeId: pagination.nodeId,
                    reason: pagination.reason,
                },
            },
        };
    }

    if (query === 'table.nextPageTarget') {
        const resolvedTarget = resolveTableNextPageTarget(snapshot, entity);
        if (!resolvedTarget.ok) {
            if (resolvedTarget.reason === 'nextActionDisabled') {
                return {
                    ok: false,
                    error: {
                        code: 'ERR_UNRESOLVED_TARGET',
                        message: 'table next page target is disabled',
                        details: {
                            businessTag: entity.businessTag,
                            entityId: entity.id,
                            reason: resolvedTarget.reason,
                        },
                    },
                };
            }
            if (resolvedTarget.reason === 'nextActionNodeMissing') {
                return {
                    ok: false,
                    error: {
                        code: 'ERR_NOT_FOUND',
                        message: 'table next page target node not found',
                        details: {
                            businessTag: entity.businessTag,
                            entityId: entity.id,
                            reason: resolvedTarget.reason,
                        },
                    },
                };
            }
            return {
                ok: false,
                error: {
                    code: 'ERR_NOT_FOUND',
                    message: 'table next page target unresolved',
                    details: {
                        businessTag: entity.businessTag,
                        entityId: entity.id,
                        diagnostic: {
                            code: 'TABLE_PAGINATION_NEXT_UNRESOLVED',
                            level: 'warning',
                            message: 'table next page target unresolved',
                            entityId: entity.id,
                            businessTag: entity.businessTag,
                            nodeIds: [entity.nodeId],
                        },
                        reason: resolvedTarget.reason,
                    },
                },
            };
        }

        return {
            ok: true,
            data: {
                kind: 'nodeId',
                nodeId: resolvedTarget.nodeId,
                meta: {
                    businessTag: entity.businessTag,
                    entityId: entity.id,
                    targetKind: 'table.nextPage',
                    actionIntent: 'nextPage',
                },
            },
        };
    }

    if (query === 'form.fields') {
        return {
            ok: true,
            data: {
                kind: 'value',
                value: (entity.formFields || []).map((field) => ({
                    fieldKey: field.fieldKey,
                    name: field.name,
                    kind: field.kind,
                    controlNodeId: field.controlNodeId,
                    labelNodeId: field.labelNodeId,
                })),
                meta: metaBase,
            },
        };
    }

    return {
        ok: true,
        data: {
            kind: 'value',
            value: (entity.formActions || []).map((action) => ({
                actionIntent: action.actionIntent,
                text: action.text,
                nodeId: action.nodeId,
            })),
            meta: metaBase,
        },
    };
};

export const resolveBusinessEntityTarget = (
    snapshot: SnapshotResult,
    finalEntityView: FinalEntityView,
    businessTag: string | undefined,
    target: BusinessEntityTarget,
): ResolverResult<BrowserQueryResult> => {
    const resolved = resolveUniqueBusinessEntity(finalEntityView, businessTag);
    if (!resolved.ok) {return resolved;}
    const entity = resolved.data;

    if ((target.kind === 'form.field' || target.kind === 'form.action') && entity.kind !== 'form') {
        return {
            ok: false,
            error: {
                code: 'ERR_BAD_ARGS',
                message: `${target.kind} requires form entity`,
                details: { businessTag, entityKind: entity.kind },
            },
        };
    }
    if ((target.kind === 'table.row' || target.kind === 'table.row_action') && entity.kind !== 'table') {
        return {
            ok: false,
            error: {
                code: 'ERR_BAD_ARGS',
                message: `${target.kind} requires table entity`,
                details: { businessTag, entityKind: entity.kind },
            },
        };
    }

    if (target.kind === 'form.field') {
        const field = finalEntityView.bindingIndex.fieldsByEntity[entity.id]?.[target.fieldKey];
        if (!field) {
            return {
                ok: false,
                error: {
                    code: 'ERR_NOT_FOUND',
                    message: 'field binding not found',
                    details: { businessTag, fieldKey: target.fieldKey },
                },
            };
        }
        if (!field.controlNodeId) {
            return {
                ok: false,
                error: {
                    code: 'ERR_UNRESOLVED_TARGET',
                    message: 'field control node is unresolved',
                    details: { businessTag, fieldKey: target.fieldKey },
                },
            };
        }
        if (!snapshot.nodeIndex[field.controlNodeId]) {
            return {
                ok: false,
                error: {
                    code: 'ERR_NOT_FOUND',
                    message: 'field control node not found in snapshot',
                    details: { businessTag, fieldKey: target.fieldKey, nodeId: field.controlNodeId },
                },
            };
        }
        return {
            ok: true,
            data: {
                kind: 'nodeId',
                nodeId: field.controlNodeId,
                meta: {
                    businessTag: entity.businessTag,
                    entityId: entity.id,
                    targetKind: 'form.field',
                    fieldKey: field.fieldKey,
                    controlKind: field.kind,
                    locator: buildEntityTargetLocator(snapshot, field.controlNodeId),
                },
            },
        };
    }

    if (target.kind === 'form.action') {
        const action = finalEntityView.bindingIndex.actionsByEntity[entity.id]?.[target.actionIntent];
        if (!action) {
            return {
                ok: false,
                error: {
                    code: 'ERR_NOT_FOUND',
                    message: 'action binding not found',
                    details: { businessTag, actionIntent: target.actionIntent },
                },
            };
        }
        if (!action.nodeId) {
            return {
                ok: false,
                error: {
                    code: 'ERR_UNRESOLVED_TARGET',
                    message: 'action node is unresolved',
                    details: { businessTag, actionIntent: target.actionIntent },
                },
            };
        }
        if (!snapshot.nodeIndex[action.nodeId]) {
            return {
                ok: false,
                error: {
                    code: 'ERR_NOT_FOUND',
                    message: 'action node not found in snapshot',
                    details: { businessTag, actionIntent: target.actionIntent, nodeId: action.nodeId },
                },
            };
        }
        return {
            ok: true,
            data: {
                kind: 'nodeId',
                nodeId: action.nodeId,
                meta: {
                    businessTag: entity.businessTag,
                    entityId: entity.id,
                    targetKind: 'form.action',
                    actionIntent: action.actionIntent,
                    locator: buildEntityTargetLocator(snapshot, action.nodeId),
                },
            },
        };
    }

    if (target.kind === 'table.row') {
        const row = resolveTableRowByPrimaryKey(snapshot, entity, {
            fieldKey: target.primaryKey.fieldKey,
            value: target.primaryKey.value,
        });
        if (!row) {
        return {
            ok: false,
            error: {
                code: 'ERR_NOT_FOUND',
                message: 'table row not found by primary key',
                    details: withDiagnosticDetails(
                        {
                            code: 'TABLE_ROW_NOT_FOUND',
                            level: 'warning',
                            message: 'table row not found by primary key',
                            entityId: entity.id,
                            businessTag: entity.businessTag,
                            fieldKey: target.primaryKey.fieldKey,
                            nodeIds: [entity.nodeId],
                            details: {
                                value: target.primaryKey.value,
                            },
                        },
                        entity,
                        finalEntityView,
                    ),
                },
            };
        }
        return {
            ok: true,
            data: {
                kind: 'nodeId',
                nodeId: row.rowNodeId,
                meta: {
                    businessTag: entity.businessTag,
                    entityId: entity.id,
                    targetKind: 'table.row',
                    rowNodeId: row.rowNodeId,
                    cellNodeId: row.cellNodeId,
                    primaryKey: {
                        fieldKey: target.primaryKey.fieldKey,
                        value: target.primaryKey.value,
                    },
                },
            },
        };
    }

    const resolvedRow = resolveTableRowByPrimaryKey(snapshot, entity, {
        fieldKey: target.primaryKey.fieldKey,
        value: target.primaryKey.value,
    });
    if (!resolvedRow) {
        return {
            ok: false,
            error: {
                code: 'ERR_NOT_FOUND',
                message: 'table row not found by primary key',
                details: withDiagnosticDetails(
                    {
                        code: 'TABLE_ROW_NOT_FOUND',
                        level: 'warning',
                        message: 'table row not found by primary key',
                        entityId: entity.id,
                        businessTag: entity.businessTag,
                        fieldKey: target.primaryKey.fieldKey,
                        nodeIds: [entity.nodeId],
                        details: {
                            value: target.primaryKey.value,
                        },
                    },
                    entity,
                    finalEntityView,
                ),
            },
        };
    }
    const rowAction = resolveTableRowAction(snapshot, entity, {
        primaryKey: {
            fieldKey: target.primaryKey.fieldKey,
            value: target.primaryKey.value,
        },
        actionIntent: target.actionIntent,
    });
    if (!rowAction) {
        return {
            ok: false,
            error: {
                code: 'ERR_UNRESOLVED_TARGET',
                message: 'table row action not found',
                details: withDiagnosticDetails(
                    {
                        code: 'TABLE_ROW_ACTION_NOT_FOUND',
                        level: 'warning',
                        message: 'table row action not found',
                        entityId: entity.id,
                        businessTag: entity.businessTag,
                        actionIntent: target.actionIntent,
                        nodeIds: [entity.nodeId, resolvedRow.rowNodeId, resolvedRow.cellNodeId],
                        details: {
                            rowNodeId: resolvedRow.rowNodeId,
                            cellNodeId: resolvedRow.cellNodeId,
                            value: target.primaryKey.value,
                        },
                    },
                    entity,
                    finalEntityView,
                ),
            },
        };
    }
    return {
        ok: true,
        data: {
            kind: 'nodeId',
            nodeId: rowAction.nodeId,
            meta: {
                businessTag: entity.businessTag,
                entityId: entity.id,
                targetKind: 'table.row_action',
                rowNodeId: rowAction.rowNodeId,
                cellNodeId: rowAction.cellNodeId,
                actionIntent: rowAction.actionIntent,
                primaryKey: {
                    fieldKey: target.primaryKey.fieldKey,
                    value: target.primaryKey.value,
                },
                locator: buildEntityTargetLocator(snapshot, rowAction.nodeId),
            },
        },
    };
};

const mapFieldKeyByColumnIndex = (
    entity: FinalEntityRecord,
    headers: string[],
    columnIndex: number,
): { fieldKey: string; header: string } => {
    const header = headers[columnIndex] || `col_${columnIndex + 1}`;
    const byIndex = (entity.columns || []).find((column) => column.columnIndex === columnIndex);
    if (byIndex) {
        return {
            fieldKey: byIndex.fieldKey,
            header,
        };
    }
    const byName = (entity.columns || []).find(
        (column) => normalizeText(column.name)?.toLowerCase() === normalizeText(header)?.toLowerCase(),
    );
    if (byName) {
        return {
            fieldKey: byName.fieldKey,
            header,
        };
    }
    return {
        fieldKey: header,
        header,
    };
};

const buildEntityTargetLocator = (snapshot: SnapshotResult, nodeId: string) => {
    return snapshot.locatorIndex[nodeId];
};

const withDiagnosticDetails = (
    diagnostic: EntityRuleDiagnostic,
    entity: FinalEntityRecord,
    finalEntityView: FinalEntityView,
): ResolverDiagnosticDetails => {
    const relatedDiagnostics = filterEntityDiagnostics(entity, finalEntityView.diagnostics || []);
    return relatedDiagnostics.length > 0 ? { diagnostic, relatedDiagnostics } : { diagnostic };
};
