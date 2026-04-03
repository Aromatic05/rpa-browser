import { applyLCA } from './lca';
import { compress } from './compress';
import type { NodeTier, UnifiedNode } from './types';

export const processRegion = (node: UnifiedNode): UnifiedNode | null => {
    const entities = detectBusinessEntities(node);
    const tree = buildTree(node);

    markStrongSemantics(tree);
    applyLCA(tree, entities);
    rankTiers(tree);

    return runCompressStage(tree);
};

const runCompressStage = (tree: UnifiedNode): UnifiedNode | null => {
    return compress(tree);
};

const detectBusinessEntities = (node: UnifiedNode): UnifiedNode[] => {
    // 第四阶段：识别结构并直接回写到 UnifiedNode 树。
    const entities: UnifiedNode[] = [];
    annotateTree(node, null, entities, null);
    annotateTableStructure(node);
    return entities;
};

const buildTree = (node: UnifiedNode): UnifiedNode => {
    // 当前仍是 passthrough，结构语义已经直接写回 UnifiedNode。
    return node;
};

const markStrongSemantics = (tree: UnifiedNode) => {
    // 第四阶段：强语义节点提供 LCA 锚点。
    walk(tree, (node) => {
        const role = node.role.toLowerCase();
        if (STRONG_ROLES.has(role)) {
            patchNode(node, {
                tier: 'A',
                attrs: {
                    strongSemantic: 'true',
                },
            });
        }
    });
};

const rankTiers = (tree: UnifiedNode) => {
    // 节点价值分级仍保持轻量占位。
    walk(tree, (node) => {
        if (node.tier) return;
        node.tier = defaultTier(node);
    });
};

const defaultTier = (_node: UnifiedNode): NodeTier => 'B';

const walk = (node: UnifiedNode, visitor: (node: UnifiedNode) => void) => {
    visitor(node);
    for (const child of node.children) {
        walk(child, visitor);
    }
};

const annotateTree = (
    node: UnifiedNode,
    parentEntityId: string | null,
    entities: UnifiedNode[],
    parentNode: UnifiedNode | null,
) => {
    annotateStructuralRoles(node, parentNode);

    if (!node.fieldLabel && isFieldControl(node)) {
        const explicit = pickExplicitFieldLabel(node);
        if (explicit) {
            patchNode(node, {
                fieldLabel: explicit,
                attrs: { fieldLabel: explicit },
            });
        }
    }

    const entityType = detectEntityType(node);
    let currentEntityId = parentEntityId;
    if (entityType) {
        currentEntityId = `entity:${node.id}`;
        patchNode(node, {
            entityId: currentEntityId,
            entityType,
            parentEntityId: parentEntityId || undefined,
            attrs: {
                entity: 'true',
                entityId: currentEntityId,
                entityType,
                parentEntityId: parentEntityId || '',
            },
        });
        entities.push(node);
    } else if (parentEntityId) {
        patchNode(node, {
            parentEntityId,
            attrs: {
                parentEntityId,
            },
        });
    }

    for (const child of node.children) {
        annotateTree(child, currentEntityId, entities, node);
    }
};

const annotateStructuralRoles = (node: UnifiedNode, parentNode: UnifiedNode | null) => {
    const tableRole = detectTableRole(node);
    if (tableRole) {
        patchNode(node, {
            tableRole,
            attrs: {
                tableRole,
            },
        });
    }

    const formRole = detectFormRole(node, parentNode);
    if (formRole) {
        patchNode(node, {
            formRole,
            attrs: {
                formRole,
            },
        });
    }
};

const detectEntityType = (node: UnifiedNode): string | null => {
    const role = normalizeRole(node.role);
    const tag = inferTag(node);
    const classes = inferClassTokens(node);

    if (node.formRole === 'form') return 'form';
    if (node.formRole === 'field_group') return 'field_group';
    if (node.tableRole === 'table') return 'table';
    if (node.tableRole === 'row') return 'row';

    if (role === 'dialog' || role === 'alertdialog') return 'dialog';
    if (role === 'listitem' || tag === 'li') return 'list_item';
    if (classes.has('ant-list-item')) return 'list_item';
    if (role === 'section' || tag === 'section') return 'section';
    if (hasClassPrefix(classes, 'ant-pro-page-header')) return 'section';

    if (looksLikeCard(node)) return 'card';
    return null;
};

const detectTableRole = (node: UnifiedNode): UnifiedNode['tableRole'] | undefined => {
    const role = normalizeRole(node.role);
    const tag = inferTag(node);
    const classes = inferClassTokens(node);

    if (role === 'table' || role === 'grid' || tag === 'table') return 'table';
    if (role === 'row' || tag === 'tr') return 'row';
    if (role === 'columnheader' || role === 'rowheader' || tag === 'th') return 'header_cell';
    if (role === 'cell' || role === 'gridcell' || tag === 'td') return 'cell';

    if (classes.has('ant-table-wrapper') || classes.has('ant-table') || classes.has('ant-table-content')) {
        return 'table';
    }
    if (classes.has('ant-table-row') || classes.has('ant-table-row-level-0')) return 'row';
    if (classes.has('ant-table-row-cell-break-word') || classes.has('ant-table-row-cell-last')) return 'cell';
    if (classes.has('ant-table-column-title') || classes.has('ant-table-header-column') || classes.has('ant-table-thead')) {
        return 'header_cell';
    }
    return undefined;
};

const detectFormRole = (node: UnifiedNode, parentNode: UnifiedNode | null): UnifiedNode['formRole'] | undefined => {
    const role = normalizeRole(node.role);
    const tag = inferTag(node);
    const classes = inferClassTokens(node);
    const parentFormRole = parentNode?.formRole || parentNode?.attrs?.formRole;
    const inFormContext = parentFormRole === 'form' || parentFormRole === 'field_group';
    const nodeSize = countNodeSize(node);

    if (role === 'form' || tag === 'form') return 'form';
    if (isFieldControl(node)) return 'field';
    if (classes.has('ant-form') || classes.has('ant-form-inline')) return 'form';
    if (classes.has('table-page-search-wrapper')) return 'form';

    const fieldDescendants = countDescendants(node, isFieldControl);
    const actionDescendants = countDescendants(node, isActionControl);
    const hasFormItemClass =
        classes.has('ant-form-item') ||
        classes.has('ant-form-item-control') ||
        classes.has('ant-form-item-control-wrapper') ||
        classes.has('ant-form-item-children');

    if (inFormContext && hasFormItemClass && fieldDescendants > 0) return 'field_group';
    if (inFormContext && fieldDescendants >= 2 && node.children.length > 1 && nodeSize <= 80) return 'field_group';

    const hasSubmitAreaClass =
        classes.has('table-operator') || classes.has('ant-pro-page-header-wrap-children-content');
    if (inFormContext && hasSubmitAreaClass && actionDescendants > 0 && fieldDescendants === 0 && role !== 'button') {
        return 'submit_area';
    }

    return undefined;
};

const countDescendants = (node: UnifiedNode, predicate: (node: UnifiedNode) => boolean): number => {
    let count = 0;
    for (const child of node.children) {
        if (predicate(child)) count += 1;
        count += countDescendants(child, predicate);
    }
    return count;
};

const countNodeSize = (node: UnifiedNode): number => {
    let count = 1;
    for (const child of node.children) {
        count += countNodeSize(child);
    }
    return count;
};

const annotateTableStructure = (root: UnifiedNode) => {
    const tables: UnifiedNode[] = [];
    walk(root, (node) => {
        if (tableRoleOf(node) === 'table') {
            tables.push(node);
        }
    });

    for (const table of tables) {
        annotateSingleTable(table);
    }
};

const annotateSingleTable = (table: UnifiedNode) => {
    annotateTableSectionContainers(table);

    const rows = collectTableRows(table);
    if (rows.length === 0) return;

    const headerRow = rows.find((row) => row.kind === 'header');
    const headerCells = headerRow ? collectRowCells(headerRow.node) : [];

    const maxColumnCount = Math.max(
        headerCells.length,
        ...rows.map((row) => collectRowCells(row.node).length),
    );
    if (maxColumnCount <= 0) return;

    const columns = Array.from({ length: maxColumnCount }, (_, index) => {
        const label = normalizeText(nodeTextValue(headerCells[index])) || '';
        const key = slugifyColumnLabel(label) || `${index}`;
        return {
            index,
            label,
            id: `col:${table.id}:${key}`,
        };
    });

    patchNode(table, {
        attrs: {
            rowCount: String(rows.filter((row) => row.kind !== 'header').length),
            columnCount: String(columns.length),
        },
    });

    let bodyRowIndex = 0;
    for (const row of rows) {
        const cells = collectRowCells(row.node);
        const isHeader = row.kind === 'header';
        const rowIndexValue = isHeader ? 'header' : String(bodyRowIndex);
        const rowIdValue = isHeader ? `row:${table.id}:header` : `row:${table.id}:${bodyRowIndex}`;

        patchNode(row.node, {
            attrs: {
                rowType: isHeader ? 'header' : 'body',
                rowIndex: rowIndexValue,
                rowId: rowIdValue,
                tableSection: isHeader ? 'header' : 'body',
            },
        });

        cells.forEach((cell, cellIndex) => {
            const column = columns[cellIndex];
            if (!column) return;

            patchNode(cell, {
                attrs: {
                    columnIndex: String(column.index),
                    columnId: column.id,
                    columnLabel: column.label,
                    rowIndex: rowIndexValue,
                    rowId: rowIdValue,
                    tableSection: isHeader ? 'header' : 'body',
                },
            });
        });

        if (!isHeader) {
            bodyRowIndex += 1;
        }
    }
};

const annotateTableSectionContainers = (table: UnifiedNode) => {
    const walkSection = (node: UnifiedNode, inherited: 'header' | 'body' | null) => {
        const classes = inferClassTokens(node);
        const tag = inferTag(node);

        let section = inherited;
        if (tag === 'thead' || classes.has('ant-table-thead')) section = 'header';
        if (tag === 'tbody' || classes.has('ant-table-tbody')) section = 'body';

        if (section) {
            patchNode(node, {
                attrs: {
                    tableSection: section,
                },
            });
        }

        for (const child of node.children) {
            walkSection(child, section);
        }
    };

    walkSection(table, null);
};

const collectTableRows = (table: UnifiedNode): Array<{ node: UnifiedNode; kind: 'header' | 'body' }> => {
    const rows: Array<{ node: UnifiedNode; kind: 'header' | 'body' }> = [];

    const walkRows = (node: UnifiedNode, inHeader: boolean) => {
        const classes = inferClassTokens(node);
        const tag = inferTag(node);
        const nextHeader = inHeader || tag === 'thead' || classes.has('ant-table-thead');
        const role = tableRoleOf(node);

        if (role === 'row') {
            const hasHeaderCell = collectRowCells(node).some((cell) => tableRoleOf(cell) === 'header_cell');
            rows.push({
                node,
                kind: nextHeader || hasHeaderCell ? 'header' : 'body',
            });
            return;
        }

        for (const child of node.children) {
            walkRows(child, nextHeader);
        }
    };

    walkRows(table, false);
    return rows;
};

const collectRowCells = (row: UnifiedNode): UnifiedNode[] => {
    const direct = row.children.filter((child) => {
        const role = tableRoleOf(child);
        return role === 'cell' || role === 'header_cell';
    });
    if (direct.length > 0) return direct;

    const cells: UnifiedNode[] = [];
    const walkCells = (node: UnifiedNode) => {
        for (const child of node.children) {
            if (tableRoleOf(child) === 'row') continue;

            const role = tableRoleOf(child);
            if (role === 'cell' || role === 'header_cell') {
                cells.push(child);
                continue;
            }
            walkCells(child);
        }
    };

    walkCells(row);
    return cells;
};

const tableRoleOf = (node: UnifiedNode): UnifiedNode['tableRole'] | undefined => {
    return node.tableRole || (node.attrs?.tableRole as UnifiedNode['tableRole'] | undefined);
};

const nodeTextValue = (node: UnifiedNode | undefined): string | undefined => {
    if (!node) return undefined;
    const self = normalizeText(node.name || node.content);
    if (self) return self;
    for (const child of node.children) {
        const text = nodeTextValue(child);
        if (text) return text;
    }
    return undefined;
};

const slugifyColumnLabel = (value: string): string => {
    if (!value) return '';
    return value
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9_]/g, '')
        .slice(0, 32);
};

const isFieldControl = (node: UnifiedNode): boolean => {
    const role = normalizeRole(node.role);
    const tag = inferTag(node);
    return FIELD_ROLES.has(role) || FIELD_TAGS.has(tag);
};

const isActionControl = (node: UnifiedNode): boolean => {
    const role = normalizeRole(node.role);
    const tag = inferTag(node);
    return ACTION_ROLES.has(role) || ACTION_TAGS.has(tag);
};

const pickExplicitFieldLabel = (node: UnifiedNode): string | undefined => {
    const attrs = node.attrs || {};
    const candidates = [attrs['aria-label'], attrs.placeholder, attrs.title, attrs.label, attrs.name];
    for (const candidate of candidates) {
        const normalized = normalizeText(candidate);
        if (normalized) return normalized;
    }
    return undefined;
};

const looksLikeCard = (node: UnifiedNode): boolean => {
    if (node.children.length < 3) return false;
    if (!hasTextSignal(node)) return false;
    if (!hasInteractiveDescendant(node)) return false;
    return true;
};

const hasTextSignal = (node: UnifiedNode): boolean => {
    const hasSelfText = (node.content || node.name || '').trim().length > 0;
    if (hasSelfText) return true;
    return node.children.some((child) => hasTextSignal(child));
};

const hasInteractiveDescendant = (node: UnifiedNode): boolean => {
    if (ACTION_ROLES.has(normalizeRole(node.role))) return true;
    if (node.attrs?.onclick || node.attrs?.href || node.attrs?.tabindex) return true;
    return node.children.some((child) => hasInteractiveDescendant(child));
};

const inferTag = (node: UnifiedNode): string => {
    const attrs = node.attrs || {};
    const raw = attrs.tag || attrs.tagName || attrs.nodeName || attrs.localName || attrs['data-tag'] || '';
    return normalizeRole(raw);
};

const inferClassTokens = (node: UnifiedNode): Set<string> => {
    const raw = node.attrs?.class || '';
    return new Set(
        raw
            .split(/\s+/)
            .map((token) => token.trim())
            .filter((token) => token.length > 0),
    );
};

const hasClassPrefix = (classes: Set<string>, prefix: string): boolean => {
    for (const item of classes) {
        if (item.startsWith(prefix)) return true;
    }
    return false;
};

const normalizeRole = (value: string | undefined): string => (value || '').trim().toLowerCase();
const normalizeText = (value: string | undefined): string | undefined => {
    const text = (value || '').trim();
    return text.length > 0 ? text : undefined;
};

const patchNode = (node: UnifiedNode, patch: Partial<UnifiedNode> & { attrs?: Record<string, string> }) => {
    if (patch.attrs) {
        node.attrs = {
            ...(node.attrs || {}),
            ...Object.fromEntries(Object.entries(patch.attrs).filter(([, value]) => value !== '')),
        };
    }
    for (const [key, value] of Object.entries(patch)) {
        if (key === 'attrs') continue;
        if (value !== undefined) {
            (node as Record<string, unknown>)[key] = value;
        }
    }
};

const STRONG_ROLES = new Set(['button', 'textbox', 'checkbox', 'link']);
const FIELD_ROLES = new Set(['input', 'textarea', 'select', 'textbox', 'combobox', 'checkbox', 'radio']);
const FIELD_TAGS = new Set(['input', 'textarea', 'select']);
const ACTION_ROLES = new Set(['button', 'link', 'menuitem']);
const ACTION_TAGS = new Set(['button', 'a']);
