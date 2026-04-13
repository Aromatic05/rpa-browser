import { getNodeAttr, getNodeContent, normalizeText } from '../core/runtime_store';
import type { EntityIndex, EntityRecord, Locator, LocatorIndex, NodeEntityRef, UnifiedNode } from '../core/types';

type BuildLocatorIndexInput = {
    root: UnifiedNode;
    entityIndex: EntityIndex;
};

export const buildLocatorIndex = (input: BuildLocatorIndexInput): LocatorIndex => {
    const { root, entityIndex } = input;
    const parentById = new Map<string, UnifiedNode | null>();
    buildParentIndex(root, null, parentById);

    const locatorIndex: LocatorIndex = {};
    walk(root, (node) => {
        if (!isLocatorTarget(node)) return;
        const primaryDomId = normalizeText(getNodeAttr(node, 'backendDOMNodeId'));
        if (!primaryDomId) return;

        const scopeEntity = resolveScopeEntity(node, parentById, entityIndex);
        const direct = buildDirectLocator(node, parentById);

        const locator: Locator = {
            origin: {
                primaryDomId,
            },
            policy: {
                preferDirect: Boolean(direct),
                preferScopedSearch: Boolean(scopeEntity),
                requireVisible: true,
                allowIndexDrift: true,
                allowFuzzy: true,
            },
        };

        if (direct) {
            locator.direct = direct;
        }
        if (scopeEntity) {
            locator.scope = {
                id: scopeEntity.id,
                kind: scopeEntity.kind,
            };
        }

        locatorIndex[node.id] = locator;
    });

    return locatorIndex;
};

const resolveScopeEntity = (
    node: UnifiedNode,
    parentById: Map<string, UnifiedNode | null>,
    entityIndex: EntityIndex,
): EntityRecord | undefined => {
    const entities = entityIndex.entities || {};
    const byNodeId = entityIndex.byNodeId || {};
    let fallback: EntityRecord | undefined;
    let fallbackScore = Number.NEGATIVE_INFINITY;

    let cursor: UnifiedNode | null = node;
    while (cursor) {
        const refs = byNodeId[cursor.id] || [];
        const picked = pickScopeRef(refs, entities);
        if (picked) {
            const entity = entities[picked.entityId];
            if (entity && picked.role === 'container') {
                return entity;
            }
            if (entity) {
                const nextScore = scoreScopeRef(picked, entity);
                if (nextScore > fallbackScore) {
                    fallback = entity;
                    fallbackScore = nextScore;
                }
            }
        }
        cursor = parentById.get(cursor.id) || null;
    }
    return fallback;
};

const pickScopeRef = (
    refs: NodeEntityRef[],
    entities: Record<string, EntityRecord>,
): NodeEntityRef | undefined => {
    let picked: NodeEntityRef | undefined;
    let score = Number.NEGATIVE_INFINITY;

    for (const ref of refs) {
        const entity = entities[ref.entityId];
        if (!entity) continue;
        const nextScore = scoreScopeRef(ref, entity);
        if (nextScore > score) {
            score = nextScore;
            picked = ref;
        }
    }

    return picked;
};

const scoreScopeRef = (ref: NodeEntityRef, entity: EntityRecord): number => {
    let score = 0;
    if (entity.type === 'region') score += 5;
    if (ref.role === 'container') score += 3;
    if (ref.role === 'item') score += 2;
    if (ref.role === 'descendant') score += 1;
    return score;
};

const buildDirectLocator = (
    node: UnifiedNode,
    parentById: Map<string, UnifiedNode | null>,
): Locator['direct'] | undefined => {
    const testId = normalizeText(getNodeAttr(node, 'data-testid') || getNodeAttr(node, 'data-test-id'));
    if (testId) {
        return {
            kind: 'css',
            query: `[data-testid="${escapeQuote(testId)}"]`,
            source: 'data-testid',
        };
    }

    const id = normalizeText(getNodeAttr(node, 'id'));
    if (id) {
        return {
            kind: 'css',
            query: `#${escapeCssId(id)}`,
            source: 'id',
        };
    }

    const href = normalizeText(getNodeAttr(node, 'href'));
    if (href && normalizeRole(node.role) === 'link' && isNavigableHref(href)) {
        return {
            kind: 'css',
            query: `a[href="${escapeQuote(href)}"]`,
            source: 'href',
        };
    }

    const tag = normalizeRole(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    const name = normalizeText(getNodeAttr(node, 'name'));
    if (tag && name) {
        return {
            kind: 'css',
            query: `${tag}[name="${escapeQuote(name)}"]`,
            source: 'name',
        };
    }

    const label = normalizeText(node.name);
    if (label) {
        const scopedCss = buildScopedTextSelector(node, parentById, label);
        return {
            kind: 'role',
            query: `${normalizeRole(node.role)}:${label}`,
            source: 'role+name',
            fallback: scopedCss,
        };
    }

    return undefined;
};

const isLocatorTarget = (node: UnifiedNode): boolean => {
    const role = normalizeRole(node.role);
    const tag = normalizeRole(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    if (LOCATOR_TARGET_ROLES.has(role)) return true;
    if (LOCATOR_TARGET_TAGS.has(tag)) return true;
    return false;
};

const buildParentIndex = (node: UnifiedNode, parent: UnifiedNode | null, parentById: Map<string, UnifiedNode | null>) => {
    parentById.set(node.id, parent);
    for (const child of node.children) {
        buildParentIndex(child, node, parentById);
    }
};

const walk = (node: UnifiedNode, visitor: (node: UnifiedNode) => void) => {
    visitor(node);
    for (const child of node.children) {
        walk(child, visitor);
    }
};

const normalizeRole = (value: string | undefined): string => (value || '').trim().toLowerCase();
const escapeQuote = (value: string): string => value.replace(/"/g, '\\"');
const escapeCssId = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '\\$&');
const escapeSelectorText = (value: string): string => value.replace(/"/g, '\\"');
const isNavigableHref = (href: string): boolean => {
    const normalized = href.trim().toLowerCase();
    if (!normalized) return false;
    if (normalized === '#') return false;
    if (normalized.startsWith('javascript:')) return false;
    return true;
};

const buildScopedTextSelector = (
    node: UnifiedNode,
    parentById: Map<string, UnifiedNode | null>,
    label: string,
): string | undefined => {
    const normalizedLabel = normalizeText(label);
    if (!normalizedLabel) return undefined;

    const nodeTag = normalizeRole(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    const leafSelector = nodeTag || roleToTagSelector(node.role);

    let cursor = parentById.get(node.id) || null;
    while (cursor) {
        const cursorTag = normalizeRole(getNodeAttr(cursor, 'tag') || getNodeAttr(cursor, 'tagName'));
        if (cursorTag === 'tr') {
            const rowKey = pickRowKeyText(cursor);
            if (rowKey) {
                return `tr:has-text("${escapeSelectorText(rowKey)}") ${leafSelector}:has-text("${escapeSelectorText(normalizedLabel)}")`;
            }
        }
        if (cursorTag === 'li') {
            const listKey = normalizeText(cursor.name || getNodeContent(cursor));
            if (listKey) {
                return `li:has-text("${escapeSelectorText(listKey)}") ${leafSelector}:has-text("${escapeSelectorText(normalizedLabel)}")`;
            }
        }
        cursor = parentById.get(cursor.id) || null;
    }

    if (leafSelector) {
        return `${leafSelector}:has-text("${escapeSelectorText(normalizedLabel)}")`;
    }
    return undefined;
};

const roleToTagSelector = (role: string): string => {
    const normalized = normalizeRole(role);
    if (normalized === 'link') return 'a';
    if (normalized === 'button') return 'button';
    if (normalized === 'textbox') return 'input,textarea';
    return '*';
};

const pickRowKeyText = (rowNode: UnifiedNode): string | undefined => {
    let matchedOrderNo: string | undefined;
    let firstCellText: string | undefined;

    walk(rowNode, (node) => {
        if (matchedOrderNo) return;
        const role = normalizeRole(node.role);
        if (role !== 'cell' && role !== 'gridcell') return;
        const text = normalizeText(node.name || getNodeContent(node));
        if (!text) return;
        if (!firstCellText) firstCellText = text;
        if (/^U\\d{6,}$/.test(text)) {
            matchedOrderNo = text;
        }
    });

    return matchedOrderNo || firstCellText;
};

const LOCATOR_TARGET_ROLES = new Set([
    'button',
    'link',
    'menuitem',
    'input',
    'textarea',
    'select',
    'textbox',
    'combobox',
    'checkbox',
    'radio',
    'tab',
]);
const LOCATOR_TARGET_TAGS = new Set(['button', 'a', 'input', 'textarea', 'select']);
