import { normalizeText } from './runtime_store';
import { buildTableStructureModel } from './table_model';
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
