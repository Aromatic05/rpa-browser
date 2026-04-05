import crypto from 'node:crypto';
import { getNodeContent, normalizeText } from './runtime_store';
import type { UnifiedNode } from './types';

export const assignStableIds = (root: UnifiedNode) => {
    const parentByNode = new Map<UnifiedNode, UnifiedNode | null>();
    buildParentIndex(root, null, parentByNode);

    const used = new Map<string, number>();
    walk(root, (node) => {
        const context = resolveLocalContext(node, parentByNode);
        const base = buildStableBase(node, context);
        const hash = shortHash(base);
        const prefix = sanitizePrefix(node.role);
        const candidate = `${prefix}_${hash}`;
        const nextCount = (used.get(candidate) || 0) + 1;
        used.set(candidate, nextCount);
        node.id = nextCount === 1 ? candidate : `${candidate}_${nextCount}`;
    });
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
            return `${role}:${normalizeName(cursor.name || getNodeContent(cursor))}`;
        }
        cursor = parentByNode.get(cursor) || null;
    }
    return 'root';
};

const buildStableBase = (node: UnifiedNode, context: string): string => {
    const role = normalizeRole(node.role);
    const name = normalizeName(node.name || getNodeContent(node));
    const target = normalizeName(node.target?.ref);
    const childCount = String(node.children.length);
    return `${role}|${name}|${context}|${target}|${childCount}`;
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

const CONTEXT_ROLES = new Set(['form', 'table', 'dialog', 'list', 'toolbar', 'section', 'article', 'main']);
