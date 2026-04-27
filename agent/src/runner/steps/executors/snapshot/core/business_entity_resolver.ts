import { normalizeText } from './runtime_store';
import { buildTableStructureModel } from './table_model';
import { resolveTableRowAction, resolveTableRowByPrimaryKey } from './entity_query';
import type { FinalEntityRecord, FinalEntityView, SnapshotResult } from './types';

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

export type BusinessEntityQuery =
    | 'table.row_count'
    | 'table.headers'
    | 'table.primary_key'
    | 'table.columns'
    | 'table.current_rows'
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
                details: { business_tag: businessTag },
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
                    business_tag: businessTag,
                    candidates: matched.map((entity) => ({
                        entity_id: entity.id,
                        node_id: entity.nodeId,
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
): ResolverResult<Record<string, unknown>> => {
    const resolved = resolveUniqueBusinessEntity(finalEntityView, businessTag);
    if (!resolved.ok) {return resolved;}
    const entity = resolved.data;

    if (query.startsWith('table.') && entity.kind !== 'table') {
        return {
            ok: false,
            error: {
                code: 'ERR_BAD_ARGS',
                message: 'table query requires table entity',
                details: { business_tag: businessTag, entity_kind: entity.kind, query },
            },
        };
    }
    if (query.startsWith('form.') && entity.kind !== 'form') {
        return {
            ok: false,
            error: {
                code: 'ERR_BAD_ARGS',
                message: 'form query requires form entity',
                details: { business_tag: businessTag, entity_kind: entity.kind, query },
            },
        };
    }

    const base = {
        business_tag: entity.businessTag,
        entity_id: entity.id,
        node_id: entity.nodeId,
    };

    if (query === 'table.row_count') {
        const model = entity.tableMeta ? null : buildTableStructureModel(snapshot, entity.nodeId);
        return {
            ok: true,
            data: {
                ...base,
                row_count: entity.tableMeta?.rowCount ?? model?.rows.length ?? 0,
            },
        };
    }

    if (query === 'table.headers') {
        const model = entity.tableMeta ? null : buildTableStructureModel(snapshot, entity.nodeId);
        return {
            ok: true,
            data: {
                ...base,
                headers: entity.tableMeta?.headers || model?.headers || [],
            },
        };
    }

    if (query === 'table.primary_key') {
        return {
            ok: true,
            data: {
                ...base,
                primary_key: entity.primaryKey
                    ? {
                          field_key: entity.primaryKey.fieldKey,
                          columns: entity.primaryKey.columns ? [...entity.primaryKey.columns] : undefined,
                          source: entity.primaryKey.source,
                      }
                    : undefined,
            },
        };
    }

    if (query === 'table.columns') {
        return {
            ok: true,
            data: {
                ...base,
                columns: (entity.columns || []).map((column) => ({
                    field_key: column.fieldKey,
                    name: column.name,
                    kind: column.kind,
                    source: column.source,
                    column_index: column.columnIndex,
                    header_node_id: column.headerNodeId,
                    actions: column.actions?.map((action) => ({
                        action_intent: action.actionIntent,
                        text: action.text,
                    })),
                })),
            },
        };
    }

    if (query === 'table.current_rows') {
        const model = buildTableStructureModel(snapshot, entity.nodeId);
        if (!model) {
            return {
                ok: true,
                data: {
                    ...base,
                    rows: [],
                },
            };
        }

        const rows = model.rows.map((row) => ({
            row_node_id: row.nodeId,
            cells: row.cells.map((cell, columnIndex) => {
                const mapped = mapFieldKeyByColumnIndex(entity, model.headers, columnIndex);
                return {
                    field_key: mapped.fieldKey,
                    header: mapped.header,
                    text: cell.value,
                    cell_node_id: cell.nodeId,
                };
            }),
        }));

        return {
            ok: true,
            data: {
                ...base,
                rows,
            },
        };
    }

    if (query === 'form.fields') {
        return {
            ok: true,
            data: {
                ...base,
                fields: (entity.formFields || []).map((field) => ({
                    field_key: field.fieldKey,
                    name: field.name,
                    kind: field.kind,
                    control_node_id: field.controlNodeId,
                    label_node_id: field.labelNodeId,
                })),
            },
        };
    }

    return {
        ok: true,
        data: {
            ...base,
            actions: (entity.formActions || []).map((action) => ({
                action_intent: action.actionIntent,
                text: action.text,
                node_id: action.nodeId,
            })),
        },
    };
};

export const resolveBusinessEntityTarget = (
    snapshot: SnapshotResult,
    finalEntityView: FinalEntityView,
    businessTag: string | undefined,
    target: BusinessEntityTarget,
): ResolverResult<Record<string, unknown>> => {
    const resolved = resolveUniqueBusinessEntity(finalEntityView, businessTag);
    if (!resolved.ok) {return resolved;}
    const entity = resolved.data;

    if ((target.kind === 'form.field' || target.kind === 'form.action') && entity.kind !== 'form') {
        return {
            ok: false,
            error: {
                code: 'ERR_BAD_ARGS',
                message: `${target.kind} requires form entity`,
                details: { business_tag: businessTag, entity_kind: entity.kind },
            },
        };
    }
    if ((target.kind === 'table.row' || target.kind === 'table.row_action') && entity.kind !== 'table') {
        return {
            ok: false,
            error: {
                code: 'ERR_BAD_ARGS',
                message: `${target.kind} requires table entity`,
                details: { business_tag: businessTag, entity_kind: entity.kind },
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
                    details: { business_tag: businessTag, field_key: target.fieldKey },
                },
            };
        }
        if (!field.controlNodeId) {
            return {
                ok: false,
                error: {
                    code: 'ERR_UNRESOLVED_TARGET',
                    message: 'field control node is unresolved',
                    details: { business_tag: businessTag, field_key: target.fieldKey },
                },
            };
        }
        if (!snapshot.nodeIndex[field.controlNodeId]) {
            return {
                ok: false,
                error: {
                    code: 'ERR_NOT_FOUND',
                    message: 'field control node not found in snapshot',
                    details: { business_tag: businessTag, field_key: target.fieldKey, node_id: field.controlNodeId },
                },
            };
        }
        return {
            ok: true,
            data: {
                business_tag: entity.businessTag,
                entity_id: entity.id,
                node_id: field.controlNodeId,
                kind: 'form.field',
                field_key: field.fieldKey,
                control_kind: field.kind,
                locator: buildEntityTargetLocator(snapshot, field.controlNodeId),
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
                    details: { business_tag: businessTag, action_intent: target.actionIntent },
                },
            };
        }
        if (!action.nodeId) {
            return {
                ok: false,
                error: {
                    code: 'ERR_UNRESOLVED_TARGET',
                    message: 'action node is unresolved',
                    details: { business_tag: businessTag, action_intent: target.actionIntent },
                },
            };
        }
        if (!snapshot.nodeIndex[action.nodeId]) {
            return {
                ok: false,
                error: {
                    code: 'ERR_NOT_FOUND',
                    message: 'action node not found in snapshot',
                    details: { business_tag: businessTag, action_intent: target.actionIntent, node_id: action.nodeId },
                },
            };
        }
        return {
            ok: true,
            data: {
                business_tag: entity.businessTag,
                entity_id: entity.id,
                node_id: action.nodeId,
                kind: 'form.action',
                action_intent: action.actionIntent,
                locator: buildEntityTargetLocator(snapshot, action.nodeId),
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
                    details: {
                        business_tag: businessTag,
                        primary_key: {
                            field_key: target.primaryKey.fieldKey,
                            value: target.primaryKey.value,
                        },
                    },
                },
            };
        }
        return {
            ok: true,
            data: {
                business_tag: entity.businessTag,
                entity_id: entity.id,
                kind: 'table.row',
                row_node_id: row.rowNodeId,
                cell_node_id: row.cellNodeId,
                primary_key: {
                    field_key: target.primaryKey.fieldKey,
                    value: target.primaryKey.value,
                },
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
                code: 'ERR_NOT_FOUND',
                message: 'table row action not found',
                details: {
                    business_tag: businessTag,
                    primary_key: {
                        field_key: target.primaryKey.fieldKey,
                        value: target.primaryKey.value,
                    },
                    action_intent: target.actionIntent,
                },
            },
        };
    }
    return {
        ok: true,
        data: {
            business_tag: entity.businessTag,
            entity_id: entity.id,
            kind: 'table.row_action',
            row_node_id: rowAction.rowNodeId,
            cell_node_id: rowAction.cellNodeId,
            node_id: rowAction.nodeId,
            action_intent: rowAction.actionIntent,
            locator: buildEntityTargetLocator(snapshot, rowAction.nodeId),
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
