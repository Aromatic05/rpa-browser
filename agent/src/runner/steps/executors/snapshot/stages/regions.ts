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

type NodeSignal = {
    size: number;
    interactive: number;
    field: number;
    listItem: number;
    row: number;
};

type RegionCandidate = {
    nodeId: string;
    kind: RegionKind;
    name?: string;
    signal: NodeSignal;
};

export const detectRegionEntities = (root: UnifiedNode): RegionDetection[] => {
    const parentById = new Map<string, UnifiedNode | null>();
    const signalById = new Map<string, NodeSignal>();
    collectNodeSignals(root, null, parentById, signalById);

    const candidates: RegionCandidate[] = [];
    walk(root, (node) => {
        const signal = signalById.get(node.id);
        if (!signal) return;

        const kind = detectRegionKind(node, signal);
        if (!kind) return;

        const name = normalizeText(node.name || getNodeContent(node));
        if (!passesRegionGate(kind, node, signal, name)) return;

        candidates.push({
            nodeId: node.id,
            kind,
            name,
            signal,
        });
    });

    if (candidates.length === 0) return [];

    const sorted = [...candidates].sort((a, b) => b.signal.size - a.signal.size);
    const keptByNodeId = new Map<string, RegionCandidate>();
    const kept: RegionCandidate[] = [];

    for (const candidate of sorted) {
        if (!passesAncestorFilter(candidate, keptByNodeId, parentById)) continue;
        keptByNodeId.set(candidate.nodeId, candidate);
        kept.push(candidate);
    }

    return capRegions(kept).map((item) => ({
        nodeId: item.nodeId,
        kind: item.kind,
        name: item.name,
    }));
};

const detectRegionKind = (node: UnifiedNode, signal: NodeSignal): RegionKind | undefined => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    const cls = normalizeLower(getNodeAttr(node, 'class'));

    if ((role === 'form' || tag === 'form') && signal.field >= 1) return 'form';
    if (role === 'table' || role === 'grid' || role === 'treegrid' || tag === 'table' || signal.row >= 2) return 'table';
    if (role === 'dialog' || role === 'alertdialog') return 'dialog';
    if (role === 'list' || role === 'listbox' || tag === 'ul' || tag === 'ol' || signal.listItem >= 3) return 'list';
    if (role === 'toolbar' || cls.includes('toolbar')) return 'toolbar';

    const isPanelRole = PANEL_ROLES.has(role) || cls.includes('panel') || cls.includes('card');
    if (!isPanelRole) return undefined;
    return 'panel';
};

const passesRegionGate = (
    kind: RegionKind,
    node: UnifiedNode,
    signal: NodeSignal,
    name: string | undefined,
): boolean => {
    const role = normalizeLower(node.role);

    if (kind === 'dialog') {
        return signal.size >= 4;
    }

    if (kind === 'toolbar') {
        return signal.interactive >= 2;
    }

    if (kind === 'table') {
        if (signal.size < 10) return false;
        if (signal.row >= 2) return true;
        return signal.interactive >= 2;
    }

    if (kind === 'list') {
        if (signal.size < 8) return false;
        if (signal.listItem >= 3) return true;
        if (!hasListSemantic(node)) return false;
        return signal.interactive >= 3;
    }

    if (kind === 'form') {
        if (signal.size < 6) return false;
        if (signal.field >= 2) return true;
        return signal.interactive >= 3;
    }

    if (kind !== 'panel') return false;
    if (role === 'main' || role === 'root') return false;
    if (node.children.length < 2) return false;
    if (signal.size < 20) return false;
    if (!name && signal.interactive < 3 && signal.field < 2) return false;
    return true;
};

const passesAncestorFilter = (
    candidate: RegionCandidate,
    keptByNodeId: Map<string, RegionCandidate>,
    parentById: Map<string, UnifiedNode | null>,
): boolean => {
    const ancestor = findNearestKeptAncestor(candidate.nodeId, keptByNodeId, parentById);
    if (!ancestor) return true;

    if (candidate.kind === 'panel' && !candidate.name) {
        return false;
    }

    if (candidate.kind === ancestor.kind && !candidate.name) {
        if (candidate.signal.size <= Math.max(12, Math.floor(ancestor.signal.size * 0.85))) {
            return false;
        }
    }

    if (!candidate.name && candidate.signal.size <= 8) {
        return false;
    }

    return true;
};

const findNearestKeptAncestor = (
    nodeId: string,
    keptByNodeId: Map<string, RegionCandidate>,
    parentById: Map<string, UnifiedNode | null>,
): RegionCandidate | undefined => {
    let cursor = parentById.get(nodeId) || null;
    while (cursor) {
        const candidate = keptByNodeId.get(cursor.id);
        if (candidate) return candidate;
        cursor = parentById.get(cursor.id) || null;
    }
    return undefined;
};

const capRegions = (items: RegionCandidate[]): RegionCandidate[] => {
    const limits: Record<RegionKind, number> = {
        panel: 12,
        form: 10,
        table: 8,
        list: 8,
        dialog: 6,
        toolbar: 4,
    };
    const used: Record<RegionKind, number> = {
        panel: 0,
        form: 0,
        table: 0,
        list: 0,
        dialog: 0,
        toolbar: 0,
    };

    const out: RegionCandidate[] = [];
    for (const item of items) {
        const usedCount = used[item.kind] || 0;
        if (usedCount >= limits[item.kind]) continue;
        used[item.kind] = usedCount + 1;
        out.push(item);
    }
    return out;
};

const collectNodeSignals = (
    node: UnifiedNode,
    parent: UnifiedNode | null,
    parentById: Map<string, UnifiedNode | null>,
    signalById: Map<string, NodeSignal>,
): NodeSignal => {
    parentById.set(node.id, parent);

    const self: NodeSignal = {
        size: 1,
        interactive: isInteractiveNode(node) ? 1 : 0,
        field: isFieldNode(node) ? 1 : 0,
        listItem: isListItemNode(node) ? 1 : 0,
        row: isRowNode(node) ? 1 : 0,
    };

    for (const child of node.children) {
        const childSignal = collectNodeSignals(child, node, parentById, signalById);
        self.size += childSignal.size;
        self.interactive += childSignal.interactive;
        self.field += childSignal.field;
        self.listItem += childSignal.listItem;
        self.row += childSignal.row;
    }

    signalById.set(node.id, self);
    return self;
};

const hasListSemantic = (node: UnifiedNode): boolean => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    const cls = normalizeLower(getNodeAttr(node, 'class'));
    if (role === 'list' || role === 'listbox' || role === 'menu' || role === 'tablist') return true;
    if (tag === 'ul' || tag === 'ol' || tag === 'menu') return true;
    if (cls.includes('list') || cls.includes('menu')) return true;
    return false;
};

const isRowNode = (node: UnifiedNode): boolean => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    return role === 'row' || tag === 'tr';
};

const isListItemNode = (node: UnifiedNode): boolean => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    return role === 'listitem' || role === 'menuitem' || role === 'option' || tag === 'li';
};

const isFieldNode = (node: UnifiedNode): boolean => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    return FIELD_ROLES.has(role) || FIELD_TAGS.has(tag);
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

const PANEL_ROLES = new Set(['section', 'article', 'region', 'complementary', 'contentinfo']);
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
const FIELD_ROLES = new Set(['textbox', 'input', 'textarea', 'select', 'combobox', 'checkbox', 'radio']);
const FIELD_TAGS = new Set(['input', 'textarea', 'select']);
