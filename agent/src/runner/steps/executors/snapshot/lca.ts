import type { UnifiedNode } from './types';

export const applyLCA = (tree: UnifiedNode, entities: UnifiedNode[]) => {
    const parentById = new Map<string, UnifiedNode | null>();
    const nodeById = new Map<string, UnifiedNode>();
    buildIndex(tree, null, parentById, nodeById);

    const entityById = new Map<string, UnifiedNode>();
    for (const entity of entities) {
        const entityId = entity.entityId || entity.attrs?.entityId;
        if (!entityId) continue;
        entityById.set(entity.id, entity);
    }

    forEachNode(tree, (node) => {
        if (!isLCATargetNode(node)) return;

        const currentEntity = resolveNodeEntity(node, nodeById, entityById);
        const entity = currentEntity || findNearestEntity(node, parentById, entityById);
        if (!entity) return;

        const context = scanEntityContext(entity, node, parentById);
        attachContext(node, entity, context);
    });
};

const forEachNode = (node: UnifiedNode, visitor: (node: UnifiedNode) => void) => {
    visitor(node);
    for (const child of node.children) {
        forEachNode(child, visitor);
    }
};

const buildIndex = (
    node: UnifiedNode,
    parent: UnifiedNode | null,
    parentById: Map<string, UnifiedNode | null>,
    nodeById: Map<string, UnifiedNode>,
) => {
    parentById.set(node.id, parent);
    nodeById.set(node.id, node);
    for (const child of node.children) {
        buildIndex(child, node, parentById, nodeById);
    }
};

const isLCATargetNode = (node: UnifiedNode): boolean => {
    const role = normalizeRole(node.role);
    if (LCA_TARGET_ROLES.has(role)) return true;
    if (role === 'button' && !nodeText(node) && hasIconSignal(node)) return true;
    if (role === 'textbox' && hasSearchOrFilterSignal(node)) return true;
    return false;
};

const resolveNodeEntity = (
    node: UnifiedNode,
    nodeById: Map<string, UnifiedNode>,
    entityById: Map<string, UnifiedNode>,
): UnifiedNode | null => {
    const entityId = node.entityId || node.attrs?.entityId;
    if (!entityId) return null;
    const hit = nodeById.get(node.id);
    if (hit && entityById.has(hit.id)) return hit;
    return null;
};

const findNearestEntity = (
    node: UnifiedNode,
    parentById: Map<string, UnifiedNode | null>,
    entityById: Map<string, UnifiedNode>,
) => {
    let cursor: UnifiedNode | null = node;
    while (cursor) {
        if (entityById.has(cursor.id)) return cursor;
        cursor = parentById.get(cursor.id) || null;
    }
    return null;
};

const scanEntityContext = (
    entity: UnifiedNode,
    node: UnifiedNode,
    parentById: Map<string, UnifiedNode | null>,
): { fieldLabel?: string; actionIntent?: string; actionTargetId?: string; entityId?: string } => {
    const entityId = entity.entityId || entity.attrs?.entityId || `entity:${entity.id}`;
    const fieldLabel = isFieldNode(node) ? findFieldLabel(entity, node, parentById) : undefined;
    const actionIntent = inferActionIntent(node, fieldLabel, entity);
    const actionTargetId = isActionNode(node) ? inferActionTargetId(entity, node, parentById) : undefined;
    return {
        fieldLabel,
        actionIntent,
        actionTargetId,
        entityId,
    };
};

const attachContext = (
    node: UnifiedNode,
    entity: UnifiedNode,
    context: { fieldLabel?: string; actionIntent?: string; actionTargetId?: string; entityId?: string },
) => {
    const entityId = context.entityId || entity.entityId || entity.attrs?.entityId || `entity:${entity.id}`;

    patchNode(node, {
        entityId,
        attrs: {
            entityId,
        },
    });

    if (context.fieldLabel) {
        patchNode(node, {
            fieldLabel: context.fieldLabel,
            attrs: {
                fieldLabel: context.fieldLabel,
            },
        });
    }

    if (context.actionIntent) {
        patchNode(node, {
            actionIntent: context.actionIntent,
            attrs: {
                actionIntent: context.actionIntent,
            },
        });
    }

    if (context.actionTargetId) {
        patchNode(node, {
            actionTargetId: context.actionTargetId,
            attrs: {
                actionTargetId: context.actionTargetId,
            },
        });
    }
};

const inferActionTargetId = (
    entity: UnifiedNode,
    node: UnifiedNode,
    parentById: Map<string, UnifiedNode | null>,
): string => {
    let cursor: UnifiedNode | null = node;
    while (cursor) {
        const tableRole = cursor.tableRole || cursor.attrs?.tableRole;
        const entityType = cursor.entityType || cursor.attrs?.entityType;
        const entityId = cursor.entityId || cursor.attrs?.entityId;
        if ((tableRole === 'row' || entityType === 'row' || entityType === 'list_item') && entityId) {
            return entityId;
        }
        if (cursor.id === entity.id) break;
        cursor = parentById.get(cursor.id) || null;
    }
    return entity.entityId || entity.attrs?.entityId || `entity:${entity.id}`;
};

const findFieldLabel = (entity: UnifiedNode, node: UnifiedNode, parentById: Map<string, UnifiedNode | null>): string | undefined => {
    // 1) 节点已有结构化字段优先。
    const known = node.fieldLabel || node.attrs?.fieldLabel;
    if (known) return known;

    // 2) 显式标签。
    const explicit = pickExplicitFieldLabel(node);
    if (explicit) return explicit;

    // 3) 表格/表单结构字段。
    const header = findStructuredHeader(entity, node, parentById);
    if (header) return header;

    // 4) 邻近文本退化。
    const sibling = findNearestSiblingText(node, parentById, entity.id);
    if (sibling) return sibling;

    const nearby = findNearbyTextByGeometry(entity, node);
    if (nearby) return nearby;

    const sectionTitle = findNearestSectionTitle(node, parentById, entity);
    if (sectionTitle) return sectionTitle;

    return undefined;
};

const findStructuredHeader = (
    entity: UnifiedNode,
    node: UnifiedNode,
    parentById: Map<string, UnifiedNode | null>,
): string | undefined => {
    let cursor: UnifiedNode | null = node;
    while (cursor) {
        const role = cursor.tableRole || cursor.attrs?.tableRole || '';
        if (role === 'header_cell') return nodeText(cursor);
        if (cursor.id === entity.id) break;
        cursor = parentById.get(cursor.id) || null;
    }

    let result: string | undefined;
    forEachNode(entity, (candidate) => {
        if (result) return;
        const role = candidate.tableRole || candidate.attrs?.tableRole || '';
        if (role !== 'header_cell') return;
        const text = nodeText(candidate);
        if (text) result = text;
    });
    return result;
};

const pickExplicitFieldLabel = (node: UnifiedNode): string | undefined => {
    const attrs = node.attrs || {};
    const candidates = [attrs['aria-label'], attrs.placeholder, attrs.title, attrs.label, attrs.name];
    for (const candidate of candidates) {
        const text = normalizeText(candidate);
        if (text) return text;
    }
    return undefined;
};

const findNearestSiblingText = (
    node: UnifiedNode,
    parentById: Map<string, UnifiedNode | null>,
    stopEntityId: string,
): string | undefined => {
    let cursor: UnifiedNode | null = node;
    while (cursor && cursor.id !== stopEntityId) {
        const parent: UnifiedNode | null = parentById.get(cursor.id) ?? null;
        if (!parent) break;
        const cursorId = cursor.id;
        const index = parent.children.findIndex((child: UnifiedNode) => child.id === cursorId);
        if (index > 0) {
            for (let i = index - 1; i >= 0; i -= 1) {
                const text = firstReadableText(parent.children[i]);
                if (text) return text;
            }
        }
        cursor = parent;
    }
    return undefined;
};

const findNearbyTextByGeometry = (entity: UnifiedNode, node: UnifiedNode): string | undefined => {
    if (!node.bbox) return undefined;
    const candidates: Array<{ text: string; score: number }> = [];
    forEachNode(entity, (candidate) => {
        if (candidate.id === node.id || !candidate.bbox) return;
        const text = nodeText(candidate);
        if (!text) return;

        const dx = node.bbox!.x - candidate.bbox.x;
        const dy = node.bbox!.y - candidate.bbox.y;
        const onLeft = dx > 0 && Math.abs(dy) <= 40;
        const above = dy > 0 && Math.abs(dx) <= 220;
        if (!onLeft && !above) return;

        const score = Math.abs(dx) + Math.abs(dy);
        candidates.push({ text, score });
    });
    candidates.sort((a, b) => a.score - b.score);
    return candidates[0]?.text;
};

const findNearestSectionTitle = (
    node: UnifiedNode,
    parentById: Map<string, UnifiedNode | null>,
    entity: UnifiedNode,
): string | undefined => {
    let cursor: UnifiedNode | null = node;
    while (cursor && cursor.id !== entity.id) {
        const parent: UnifiedNode | null = parentById.get(cursor.id) ?? null;
        if (!parent) break;
        const title = findHeadingText(parent);
        if (title) return title;
        cursor = parent;
    }
    return findHeadingText(entity);
};

const findHeadingText = (node: UnifiedNode | null): string | undefined => {
    if (!node) return undefined;
    for (const child of node.children) {
        const role = normalizeRole(child.role);
        const tableRole = child.tableRole || child.attrs?.tableRole || '';
        if (role === 'heading' || role === 'label' || tableRole === 'header_cell') {
            const text = nodeText(child);
            if (text) return text;
        }
    }
    return undefined;
};

const inferActionIntent = (node: UnifiedNode, fieldLabel: string | undefined, entity: UnifiedNode): string | undefined => {
    const text = [
        node.name,
        node.content,
        fieldLabel,
        node.attrs?.['aria-label'],
        node.attrs?.title,
        node.attrs?.placeholder,
        entity.name,
        entity.content,
    ]
        .map((item) => normalizeText(item))
        .filter((item): item is string => Boolean(item))
        .join(' ')
        .toLowerCase();

    for (const [intent, keywords] of ACTION_INTENT_KEYWORDS) {
        if (keywords.some((keyword) => text.includes(keyword))) return intent;
    }

    const role = normalizeRole(node.role);
    if (role === 'link') return 'open';
    if (role === 'button') return 'submit';
    if (role === 'textbox' && hasSearchOrFilterSignal(node)) return text.includes('filter') ? 'filter' : 'search';
    return undefined;
};

const isFieldNode = (node: UnifiedNode): boolean => {
    const role = normalizeRole(node.role);
    const formRole = node.formRole || node.attrs?.formRole || '';
    return FIELD_ROLES.has(role) || formRole === 'field';
};

const isActionNode = (node: UnifiedNode): boolean => {
    const role = normalizeRole(node.role);
    return ACTION_ROLES.has(role);
};

const hasSearchOrFilterSignal = (node: UnifiedNode): boolean => {
    const text = [
        node.name,
        node.content,
        node.attrs?.['aria-label'],
        node.attrs?.placeholder,
        node.attrs?.id,
        node.attrs?.class,
    ]
        .map((item) => normalizeText(item))
        .filter((item): item is string => Boolean(item))
        .join(' ')
        .toLowerCase();
    return text.includes('search') || text.includes('filter');
};

const hasIconSignal = (node: UnifiedNode): boolean => {
    const attrs = node.attrs || {};
    const cls = `${attrs.class || ''} ${attrs.icon || ''}`.toLowerCase();
    return cls.includes('icon') || cls.includes('svg');
};

const firstReadableText = (node: UnifiedNode): string | undefined => {
    const self = nodeText(node);
    if (self) return self;
    for (const child of node.children) {
        const text = firstReadableText(child);
        if (text) return text;
    }
    return undefined;
};

const nodeText = (node: UnifiedNode): string | undefined => normalizeText(node.name || node.content);

const normalizeRole = (value: string | undefined): string => (value || '').trim().toLowerCase();
const normalizeText = (value: string | undefined): string | undefined => {
    const text = (value || '').trim();
    return text.length > 0 ? text : undefined;
};

const patchNode = (
    node: UnifiedNode,
    patch: Partial<UnifiedNode> & {
        attrs?: Record<string, string>;
    },
) => {
    if (patch.attrs) {
        node.attrs = {
            ...(node.attrs || {}),
            ...patch.attrs,
        };
    }

    for (const [key, value] of Object.entries(patch)) {
        if (key === 'attrs') continue;
        if (value !== undefined) {
            (node as Record<string, unknown>)[key] = value;
        }
    }
};

const LCA_TARGET_ROLES = new Set([
    'input',
    'textarea',
    'select',
    'textbox',
    'combobox',
    'button',
    'link',
    'menuitem',
]);
const FIELD_ROLES = new Set(['input', 'textarea', 'select', 'textbox', 'combobox', 'checkbox', 'radio']);
const ACTION_ROLES = new Set(['button', 'link', 'menuitem']);
const ACTION_INTENT_KEYWORDS = new Map<string, string[]>([
    ['submit', ['submit', 'save', 'apply', 'confirm', 'ok', '提交', '保存', '确认']],
    ['edit', ['edit', 'rename', 'update', '修改', '编辑']],
    ['delete', ['delete', 'remove', 'trash', 'clear', '删除', '移除']],
    ['open', ['open', 'view', 'details', 'more', '打开', '查看', '详情']],
    ['search', ['search', 'find', 'lookup', '搜索', '查找']],
    ['filter', ['filter', '筛选', '过滤']],
    ['create', ['create', 'new', 'add', '新增', '创建', '添加']],
    ['close', ['close', 'cancel', 'dismiss', '关闭', '取消']],
]);
