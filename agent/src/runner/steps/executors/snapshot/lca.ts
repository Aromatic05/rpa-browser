import type { SemanticNode } from './types';

export const applyLCA = (tree: SemanticNode, entities: SemanticNode[]) => {
    const parentById = new Map<string, SemanticNode | null>();
    const nodeById = new Map<string, SemanticNode>();
    buildIndex(tree, null, parentById, nodeById);

    const entityById = new Map<string, SemanticNode>();
    for (const entity of entities) {
        const entityType = entity.attrs?.entityType || '';
        if (!BUSINESS_ENTITY_TYPES.has(entityType)) continue;
        entityById.set(entity.id, entity);
    }

    // 对弱语义但重要的节点做最近业务实体归因，再扫描局部上下文。
    forEachNode(tree, (node) => {
        if (!isLCATargetNode(node)) return;
        const entity = findNearestEntity(node, parentById, entityById);
        if (!entity) return;

        const liveEntity = nodeById.get(entity.id) || entity;
        const context = scanEntityContext(liveEntity, node, parentById);
        attachContext(node, liveEntity, context);
    });
};

const forEachNode = (node: SemanticNode, visitor: (node: SemanticNode) => void) => {
    visitor(node);
    for (const child of node.children) {
        forEachNode(child, visitor);
    }
};

const buildIndex = (
    node: SemanticNode,
    parent: SemanticNode | null,
    parentById: Map<string, SemanticNode | null>,
    nodeById: Map<string, SemanticNode>,
) => {
    parentById.set(node.id, parent);
    nodeById.set(node.id, node);
    for (const child of node.children) {
        buildIndex(child, node, parentById, nodeById);
    }
};

const isLCATargetNode = (node: SemanticNode) => {
    const role = normalizeRole(node.role);
    if (LCA_TARGET_ROLES.has(role)) return true;

    // icon button / 行内按钮 / 搜索筛选控件：允许无文本按钮和带搜索筛选信号的输入控件。
    if (role === 'button' && !nodeText(node) && hasIconSignal(node)) return true;
    if (role === 'textbox' && hasSearchOrFilterSignal(node)) return true;
    return false;
};

const findNearestEntity = (
    node: SemanticNode,
    parentById: Map<string, SemanticNode | null>,
    entityById: Map<string, SemanticNode>,
) => {
    let cursor: SemanticNode | null = node;
    while (cursor) {
        const matched = entityById.get(cursor.id);
        if (matched) return matched;
        cursor = parentById.get(cursor.id) || null;
    }
    return null;
};

const scanEntityContext = (entity: SemanticNode, node: SemanticNode, parentById: Map<string, SemanticNode | null>) => {
    const fieldLabel = isFieldNode(node) ? findFieldLabel(entity, node, parentById) : undefined;
    const actionIntent = inferActionIntent(node, fieldLabel);
    return {
        fieldLabel,
        actionIntent,
    };
};

const attachContext = (
    node: SemanticNode,
    entity: SemanticNode,
    context: { fieldLabel?: string; actionIntent?: string },
) => {
    const entityId = entity.attrs?.entityId || `entity:${entity.id}`;
    node.attrs = {
        ...(node.attrs || {}),
        entityId,
    };

    if (context.fieldLabel) {
        node.attrs.fieldLabel = context.fieldLabel;
    }

    if (isActionNode(node)) {
        node.attrs.actionTargetId = entityId;
        if (context.actionIntent) {
            node.attrs.actionIntent = context.actionIntent;
        }
    } else if (context.actionIntent && hasSearchOrFilterSignal(node)) {
        node.attrs.actionIntent = context.actionIntent;
    }
};

const findFieldLabel = (entity: SemanticNode, node: SemanticNode, parentById: Map<string, SemanticNode | null>): string | undefined => {
    const explicit = pickExplicitFieldLabel(node);
    if (explicit) return explicit;

    const sibling = findNearestSiblingText(node, parentById, entity.id);
    if (sibling) return sibling;

    const geometryHint = findNearbyTextByGeometry(entity, node);
    if (geometryHint) return geometryHint;

    const sectionTitle = findNearestSectionTitle(node, parentById, entity);
    if (sectionTitle) return sectionTitle;

    const tableHeader = findTableHeader(entity);
    if (tableHeader) return tableHeader;

    return undefined;
};

const pickExplicitFieldLabel = (node: SemanticNode): string | undefined => {
    const attrs = node.attrs || {};
    const candidates = [attrs['aria-label'], attrs.placeholder, attrs.title, attrs.label, attrs.name];
    for (const candidate of candidates) {
        const text = normalizeText(candidate);
        if (text) return text;
    }
    return undefined;
};

const findNearestSiblingText = (
    node: SemanticNode,
    parentById: Map<string, SemanticNode | null>,
    stopEntityId: string,
): string | undefined => {
    let cursor: SemanticNode | null = node;
    while (cursor && cursor.id !== stopEntityId) {
        const parent: SemanticNode | null = parentById.get(cursor.id) ?? null;
        if (!parent) break;

        const cursorId = cursor.id;
        const index = parent.children.findIndex((child: SemanticNode) => child.id === cursorId);
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

const findNearbyTextByGeometry = (entity: SemanticNode, node: SemanticNode): string | undefined => {
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
    node: SemanticNode,
    parentById: Map<string, SemanticNode | null>,
    entity: SemanticNode,
): string | undefined => {
    let cursor: SemanticNode | null = node;
    while (cursor && cursor.id !== entity.id) {
        const parent: SemanticNode | null = parentById.get(cursor.id) ?? null;
        if (!parent) break;

        const title = findHeadingText(parent);
        if (title) return title;
        cursor = parent;
    }
    return findHeadingText(entity);
};

const findHeadingText = (node: SemanticNode | null): string | undefined => {
    if (!node) return undefined;
    for (const child of node.children) {
        const role = normalizeRole(child.role);
        if (role === 'heading' || role === 'label' || role === 'rowheader' || role === 'columnheader') {
            const text = nodeText(child);
            if (text) return text;
        }
    }
    return undefined;
};

const findTableHeader = (entity: SemanticNode): string | undefined => {
    let result: string | undefined;
    forEachNode(entity, (node) => {
        if (result) return;
        const role = normalizeRole(node.role);
        if (role !== 'rowheader' && role !== 'columnheader' && role !== 'heading') return;
        const text = nodeText(node);
        if (text) result = text;
    });
    return result;
};

const inferActionIntent = (node: SemanticNode, fieldLabel?: string): string | undefined => {
    const text = [
        node.name,
        node.content,
        fieldLabel,
        node.attrs?.['aria-label'],
        node.attrs?.title,
        node.attrs?.placeholder,
        node.attrs?.class,
        node.attrs?.id,
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

const isFieldNode = (node: SemanticNode): boolean => {
    const role = normalizeRole(node.role);
    return role === 'textbox' || role === 'input' || role === 'textarea' || role === 'select' || role === 'combobox';
};

const isActionNode = (node: SemanticNode): boolean => {
    const role = normalizeRole(node.role);
    return role === 'button' || role === 'link' || role === 'menuitem';
};

const hasSearchOrFilterSignal = (node: SemanticNode): boolean => {
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

const hasIconSignal = (node: SemanticNode): boolean => {
    const attrs = node.attrs || {};
    const cls = `${attrs.class || ''} ${attrs.icon || ''}`.toLowerCase();
    return cls.includes('icon') || cls.includes('svg');
};

const firstReadableText = (node: SemanticNode): string | undefined => {
    const self = nodeText(node);
    if (self) return self;
    for (const child of node.children) {
        const text = firstReadableText(child);
        if (text) return text;
    }
    return undefined;
};

const nodeText = (node: SemanticNode): string | undefined => normalizeText(node.name || node.content);

const normalizeRole = (value: string | undefined): string => (value || '').trim().toLowerCase();

const normalizeText = (value: string | undefined): string | undefined => {
    const text = (value || '').trim();
    return text.length > 0 ? text : undefined;
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

const BUSINESS_ENTITY_TYPES = new Set(['form', 'row', 'card', 'dialog', 'list_item']);

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
