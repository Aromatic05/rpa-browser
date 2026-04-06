import { getNodeAttr, normalizeText } from '../core/runtime_store';
import type { EntityIndex, Locator, LocatorIndex, UnifiedNode } from '../core/types';

type BuildLocatorIndexInput = {
    root: UnifiedNode;
    entityIndex: EntityIndex;
    nodeEntityIndex: Record<string, string>;
};

export const buildLocatorIndex = (input: BuildLocatorIndexInput): LocatorIndex => {
    const { root, entityIndex, nodeEntityIndex } = input;
    const parentById = new Map<string, UnifiedNode | null>();
    buildParentIndex(root, null, parentById);

    const locatorIndex: LocatorIndex = {};
    walk(root, (node) => {
        if (!isLocatorTarget(node)) return;
        const primaryDomId = normalizeText(getNodeAttr(node, 'backendDOMNodeId'));
        if (!primaryDomId) return;

        const scopeEntityId = resolveScopeEntityId(node, parentById, nodeEntityIndex);
        const scopeEntity = scopeEntityId ? entityIndex[scopeEntityId] : undefined;
        const direct = buildDirectLocator(node);

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

const resolveScopeEntityId = (
    node: UnifiedNode,
    parentById: Map<string, UnifiedNode | null>,
    nodeEntityIndex: Record<string, string>,
): string | undefined => {
    let cursor: UnifiedNode | null = node;
    while (cursor) {
        const entityId = nodeEntityIndex[cursor.id];
        if (entityId) return entityId;
        cursor = parentById.get(cursor.id) || null;
    }
    return undefined;
};

const buildDirectLocator = (node: UnifiedNode): Locator['direct'] | undefined => {
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
        return {
            kind: 'role',
            query: `${normalizeRole(node.role)}:${label}`,
            source: 'role+name',
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
const isNavigableHref = (href: string): boolean => {
    const normalized = href.trim().toLowerCase();
    if (!normalized) return false;
    if (normalized === '#') return false;
    if (normalized.startsWith('javascript:')) return false;
    return true;
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
