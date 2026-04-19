import crypto from 'node:crypto';
import { getNodeAttr, getNodeContent, normalizeText } from './runtime_store';
import type { UnifiedNode } from './types';

export const assignStableIds = (root: UnifiedNode) => {
    const parentByNode = new Map<UnifiedNode, UnifiedNode | null>();
    buildParentIndex(root, null, parentByNode);
    const nodes: UnifiedNode[] = [];
    walk(root, (node) => {
        nodes.push(node);
    });

    const bucketByCandidate = new Map<string, Array<{ node: UnifiedNode; tieKey: string }>>();
    for (const node of nodes) {
        const context = resolveLocalContext(node, parentByNode);
        const base = buildStableBase(node, context, parentByNode);
        const hash = shortHash(base);
        const prefix = sanitizePrefix(node.role);
        const candidate = `${prefix}_${hash}`;
        const bucket = bucketByCandidate.get(candidate) || [];
        bucket.push({
            node,
            tieKey: buildTieBreakKey(node, parentByNode),
        });
        bucketByCandidate.set(candidate, bucket);
    }

    for (const [candidate, bucket] of bucketByCandidate.entries()) {
        if (bucket.length === 1) {
            const only = bucket[0];
            if (only) only.node.id = candidate;
            continue;
        }

        bucket.sort((left, right) => left.tieKey.localeCompare(right.tieKey));
        for (let i = 0; i < bucket.length; i += 1) {
            const item = bucket[i];
            if (!item) continue;
            item.node.id = i === 0 ? candidate : `${candidate}_${i + 1}`;
        }
    }
};

const buildParentIndex = (node: UnifiedNode, parent: UnifiedNode | null, parentByNode: Map<UnifiedNode, UnifiedNode | null>) => {
    parentByNode.set(node, parent);
    for (const child of node.children) {
        buildParentIndex(child, node, parentByNode);
    }
};

const walk = (node: UnifiedNode, visitor: (node: UnifiedNode) => void) => {
    visitor(node);
    for (const child of node.children) {
        walk(child, visitor);
    }
};

const resolveLocalContext = (node: UnifiedNode, parentByNode: Map<UnifiedNode, UnifiedNode | null>): string => {
    let cursor = parentByNode.get(node) || null;
    while (cursor) {
        const role = normalizeRole(cursor.role);
        if (CONTEXT_ROLES.has(role)) {
            return role;
        }
        cursor = parentByNode.get(cursor) || null;
    }
    return 'root';
};

const buildStableBase = (
    node: UnifiedNode,
    context: string,
    parentByNode: Map<UnifiedNode, UnifiedNode | null>,
): string => {
    const role = normalizeRole(node.role);
    const tag = normalizeRole(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    const backendDomId = normalizeBackendDomId(getNodeAttr(node, 'backendDOMNodeId'));
    const name = normalizeNameForId(node.name || getNodeContent(node));
    const target = normalizeName(node.target?.ref);
    const lineage = collectBackendLineage(node, parentByNode);
    const shape = buildShapeSignature(node);

    if (backendDomId) {
        return `backend:${backendDomId}|role:${role}|tag:${tag}|ctx:${context}`;
    }

    return `fallback:${role}|${tag}|${name}|${context}|${target}|lineage:${lineage}|shape:${shape}`;
};

const buildTieBreakKey = (
    node: UnifiedNode,
    parentByNode: Map<UnifiedNode, UnifiedNode | null>,
): string => {
    const role = normalizeRole(node.role);
    const tag = normalizeRole(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    const name = normalizeNameForId(node.name || getNodeContent(node));
    const target = normalizeName(node.target?.ref);
    const lineage = collectBackendLineage(node, parentByNode);
    const ancestorRoles = collectAncestorRoles(node, parentByNode);
    const shape = buildShapeSignature(node);
    return `${lineage}|${ancestorRoles}|${role}|${tag}|${name}|${target}|${shape}`;
};

const collectBackendLineage = (
    node: UnifiedNode,
    parentByNode: Map<UnifiedNode, UnifiedNode | null>,
): string => {
    const ids: string[] = [];
    let cursor: UnifiedNode | null = node;
    for (let depth = 0; cursor && depth < 4; depth += 1) {
        const backendId = normalizeBackendDomId(getNodeAttr(cursor, 'backendDOMNodeId'));
        if (backendId) ids.push(backendId);
        cursor = parentByNode.get(cursor) || null;
    }
    return ids.join('/');
};

const collectAncestorRoles = (
    node: UnifiedNode,
    parentByNode: Map<UnifiedNode, UnifiedNode | null>,
): string => {
    const roles: string[] = [];
    let cursor = parentByNode.get(node) || null;
    for (let depth = 0; cursor && depth < 5; depth += 1) {
        const role = normalizeRole(cursor.role);
        if (role) roles.push(role);
        cursor = parentByNode.get(cursor) || null;
    }
    return roles.join('/');
};

const buildShapeSignature = (node: UnifiedNode): string => {
    const role = normalizeRole(node.role);
    const tag = normalizeRole(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    const childRoles = node.children
        .slice(0, 6)
        .map((child) => normalizeRole(child.role))
        .sort()
        .join(',');
    return `${role}|${tag}|c:${node.children.length}|cr:${childRoles}`;
};

const shortHash = (value: string): string => {
    return crypto.createHash('sha1').update(value).digest('hex').slice(0, 10);
};

const sanitizePrefix = (role: string): string => {
    const normalized = normalizeRole(role).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!normalized) return 'node';
    return normalized.slice(0, 16);
};

const normalizeRole = (value: string | undefined): string => (value || '').trim().toLowerCase();
const normalizeName = (value: string | undefined): string => {
    return (normalizeText(value) || '').toLowerCase().slice(0, 80);
};
const normalizeNameForId = (value: string | undefined): string => {
    const normalized = normalizeName(value);
    if (!normalized) return '';
    return normalized
        // reduce small textual drifts (counts, dates, dynamic ids)
        .replace(/\d+/g, '#')
        // keep semantic words, down-weight punctuation noise
        .replace(/[^\p{L}\p{N}\s#]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 64);
};

const normalizeBackendDomId = (value: string | undefined): string | undefined => {
    const normalized = normalizeText(value);
    if (!normalized) return undefined;
    if (!/^\d+$/.test(normalized)) return undefined;
    return normalized;
};

const CONTEXT_ROLES = new Set(['form', 'table', 'dialog', 'list', 'toolbar', 'section', 'article', 'main']);
