import crypto from 'node:crypto';
import { cloneTreeWithRuntime, getNodeAttr, getNodeContent, normalizeText } from './runtime_store';
import type { SnapshotCacheStats, UnifiedNode } from './types';

type BucketCacheEntry = {
    key: string;
    hash: string;
    subtree: UnifiedNode;
    updatedAt: number;
};

const bucketCache = new Map<string, BucketCacheEntry>();

export const createCacheStats = (): SnapshotCacheStats => ({
    bucketTotal: 0,
    bucketHit: 0,
    bucketMiss: 0,
});

export const computeBucketKey = (region: UnifiedNode): string => {
    const domId = normalizeText(getNodeAttr(region, 'backendDOMNodeId')) || 'no-dom-id';
    const role = normalizeRole(region.role);
    const name = normalizeName(region.name || getNodeContent(region));
    return `${role}|${domId}|${name}`;
};

export const computeBucketHash = (region: UnifiedNode): string => {
    const signature = collectRegionSignature(region);
    return crypto.createHash('sha1').update(signature).digest('hex').slice(0, 16);
};

export const readBucketCache = (bucketKey: string, hash: string): UnifiedNode | null => {
    const cached = bucketCache.get(bucketKey);
    if (!cached) return null;
    if (cached.hash !== hash) return null;
    return cloneTreeWithRuntime(cached.subtree);
};

export const writeBucketCache = (bucketKey: string, hash: string, processed: UnifiedNode) => {
    bucketCache.set(bucketKey, {
        key: bucketKey,
        hash,
        subtree: cloneTreeWithRuntime(processed),
        updatedAt: Date.now(),
    });
};

const collectRegionSignature = (root: UnifiedNode): string => {
    const chunks: string[] = [];
    walk(root, (node, depth) => {
        const state = collectInteractiveStateSignature(node);
        if (depth > 3 && !isStatefulNode(node, state)) return;
        const role = normalizeRole(node.role);
        const name = normalizeName(node.name || getNodeContent(node));
        const domId = normalizeText(getNodeAttr(node, 'backendDOMNodeId')) || '';
        const tag = normalizeRole(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
        const childCount = node.children.length;
        chunks.push(`${depth}:${role}:${name}:${tag}:${domId}:${state}:${childCount}`);
    });
    return chunks.join('|');
};

const collectInteractiveStateSignature = (node: UnifiedNode): string => {
    const raw = [
        normalizeStateText(getNodeAttr(node, 'value')),
        normalizeStateText(getNodeAttr(node, 'checked')),
        normalizeStateText(getNodeAttr(node, 'selected')),
        normalizeStateText(getNodeAttr(node, 'aria-checked')),
        normalizeStateText(getNodeAttr(node, 'aria-selected')),
        normalizeStateText(getNodeAttr(node, 'aria-expanded')),
        normalizeStateText(getNodeAttr(node, 'aria-pressed')),
        normalizeStateText(getNodeAttr(node, 'aria-invalid')),
        normalizeStateText(getNodeAttr(node, 'focused')),
        normalizeStateText(getNodeAttr(node, 'disabled')),
        normalizeStateText(getNodeAttr(node, 'readonly')),
    ];
    return raw.join('~');
};

const normalizeStateText = (value: string | undefined): string => {
    const normalized = normalizeText(value);
    if (!normalized) return '';
    return normalized.toLowerCase().replace(/;/g, ',').slice(0, 48);
};

const isStatefulNode = (node: UnifiedNode, stateSignature: string): boolean => {
    if (stateSignature && stateSignature !== EMPTY_STATE_SIGNATURE) return true;
    const role = normalizeRole(node.role);
    if (STATEFUL_ROLES.has(role)) return true;
    const tag = normalizeRole(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    if (STATEFUL_TAGS.has(tag)) return true;
    return false;
};

const walk = (node: UnifiedNode, visitor: (node: UnifiedNode, depth: number) => void, depth = 0) => {
    visitor(node, depth);
    for (const child of node.children) {
        walk(child, visitor, depth + 1);
    }
};

const normalizeRole = (value: string | undefined): string => (value || '').trim().toLowerCase();
const normalizeName = (value: string | undefined): string => (normalizeText(value) || '').toLowerCase().slice(0, 64);
const STATEFUL_ROLES = new Set(['checkbox', 'radio', 'switch', 'textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton']);
const STATEFUL_TAGS = new Set(['input', 'textarea', 'select', 'option']);
const EMPTY_STATE_SIGNATURE = Array.from({ length: 11 }, () => '').join('~');
