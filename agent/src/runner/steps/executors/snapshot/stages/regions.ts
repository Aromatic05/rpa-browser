import { getNodeAttr, getNodeContent, normalizeText } from '../core/runtime_store';
import type { RegionKind, UnifiedNode } from '../core/types';

export const detectRegions = (node: UnifiedNode): UnifiedNode[] => {
    if (node.children.length === 0) return [node];
    // 返回快照，避免上游边遍历边替换/删除 children 时跳过后续 region。
    return [...node.children];
};

export type RegionDetection = {
    nodeId: string;
    kind: RegionKind;
    name?: string;
};

export const detectRegionEntities = (root: UnifiedNode): RegionDetection[] => {
    const regions: RegionDetection[] = [];
    const seen = new Set<string>();

    walk(root, (node) => {
        const kind = detectRegionKind(node);
        if (!kind) return;
        if (seen.has(node.id)) return;
        seen.add(node.id);
        regions.push({
            nodeId: node.id,
            kind,
            name: normalizeText(node.name || getNodeContent(node)),
        });
    });

    return regions;
};

const detectRegionKind = (node: UnifiedNode): RegionKind | undefined => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    const cls = normalizeLower(getNodeAttr(node, 'class'));

    if (role === 'form' || tag === 'form') return 'form';
    if (role === 'table' || role === 'grid' || role === 'treegrid' || tag === 'table') return 'table';
    if (role === 'dialog' || role === 'alertdialog') return 'dialog';
    if (role === 'list' || role === 'listbox' || tag === 'ul' || tag === 'ol') return 'list';
    if (role === 'toolbar' || cls.includes('toolbar')) return 'toolbar';

    const isPanelRole = PANEL_ROLES.has(role) || cls.includes('panel') || cls.includes('card');
    if (!isPanelRole) return undefined;
    if (node.children.length === 0) return undefined;
    if (!hasRegionSignal(node)) return undefined;
    return 'panel';
};

const hasRegionSignal = (node: UnifiedNode): boolean => {
    if (normalizeText(node.name || getNodeContent(node))) return true;
    if (hasInteractiveDescendant(node, 2)) return true;
    return node.children.length >= 2;
};

const hasInteractiveDescendant = (node: UnifiedNode, depthLimit: number): boolean => {
    const queue: Array<{ node: UnifiedNode; depth: number }> = [{ node, depth: 0 }];
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) break;
        if (current.depth > depthLimit) continue;
        if (current.depth > 0 && isInteractiveNode(current.node)) return true;
        if (current.depth === depthLimit) continue;
        for (const child of current.node.children) {
            queue.push({ node: child, depth: current.depth + 1 });
        }
    }
    return false;
};

const isInteractiveNode = (node: UnifiedNode): boolean => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    if (INTERACTIVE_ROLES.has(role) || INTERACTIVE_TAGS.has(tag)) return true;
    if (node.target) return true;
    if (getNodeAttr(node, 'onclick') || getNodeAttr(node, 'href') || getNodeAttr(node, 'tabindex')) return true;
    return false;
};

const walk = (node: UnifiedNode, visitor: (node: UnifiedNode) => void) => {
    visitor(node);
    for (const child of node.children) {
        walk(child, visitor);
    }
};

const normalizeLower = (value: string | undefined): string => (value || '').trim().toLowerCase();

const PANEL_ROLES = new Set(['section', 'article', 'region', 'main', 'complementary', 'contentinfo']);
const INTERACTIVE_ROLES = new Set([
    'button',
    'link',
    'textbox',
    'input',
    'textarea',
    'select',
    'checkbox',
    'radio',
    'combobox',
    'menuitem',
    'tab',
]);
const INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'textarea', 'select']);
