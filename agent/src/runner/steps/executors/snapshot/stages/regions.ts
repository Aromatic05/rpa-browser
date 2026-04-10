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
    signal: NodeSignal;
    evidence: RegionEvidence;
};

export type NodeSignal = {
    size: number;
    interactive: number;
    field: number;
    listItem: number;
    row: number;
    heading: number;
    prose: number;
};

export type RegionEvidence = {
    explicitRole: boolean;
    explicitTag: boolean;
    explicitClass: boolean;
    shellLike: boolean;
    codeLike: boolean;
    headingDominant: boolean;
};

export const detectRegionEntities = (root: UnifiedNode): RegionDetection[] => {
    const signalById = new Map<string, NodeSignal>();
    collectNodeSignals(root, signalById);

    const candidates: RegionDetection[] = [];
    walk(root, (node) => {
        const signal = signalById.get(node.id);
        if (!signal) return;

        const kind = detectRegionKind(node, signal);
        if (!kind) return;

        const name = normalizeText(node.name || getNodeContent(node));
        const evidence = buildRegionEvidence(node, signal);
        if (!passesRegionDetectionFloor(kind, signal, evidence, name)) return;

        candidates.push({
            nodeId: node.id,
            kind,
            name,
            signal,
            evidence,
        });
    });

    return candidates;
};

const detectRegionKind = (node: UnifiedNode, signal: NodeSignal): RegionKind | undefined => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    const cls = normalizeLower(getNodeAttr(node, 'class'));

    if (isCodeLikeNode(role, tag, cls)) return undefined;
    if (isTableAtomicNode(role, tag)) return undefined;
    if (isPaginationLikeNode(role, tag, cls)) return undefined;

    if ((role === 'form' || tag === 'form') && signal.field >= 1) return 'form';
    const explicitList = role === 'list' || role === 'listbox' || tag === 'ul' || tag === 'ol';
    if (explicitList) return 'list';
    if (signal.listItem >= 3 && hasListSemantic(node)) return 'list';
    if (isTableLikeNode(role, tag, cls) || hasDenseRowChildren(node)) return 'table';
    if (role === 'dialog' || role === 'alertdialog') return 'dialog';
    if (role === 'toolbar' || cls.includes('toolbar')) return 'toolbar';

    const isPanelRole = PANEL_ROLES.has(role) || cls.includes('panel') || cls.includes('card');
    if (!isPanelRole) return undefined;
    return 'panel';
};

const buildRegionEvidence = (node: UnifiedNode, signal: NodeSignal): RegionEvidence => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    const cls = normalizeLower(getNodeAttr(node, 'class'));
    return {
        explicitRole: role.length > 0 && !SHELL_ROLES.has(role) && role !== 'generic' && role !== 'none' && role !== 'presentation',
        explicitTag: tag.length > 0 && tag !== 'div' && tag !== 'span' && tag !== 'p',
        explicitClass: TABLE_KEYWORDS.some((keyword) => cls.includes(keyword)) || cls.includes('panel') || cls.includes('card') || cls.includes('form') || cls.includes('list'),
        shellLike: SHELL_ROLES.has(role),
        codeLike: isCodeLikeNode(role, tag, cls),
        headingDominant: signal.heading > 0 && signal.heading / Math.max(1, signal.size) >= 0.12,
    };
};

const passesRegionDetectionFloor = (
    kind: RegionKind,
    signal: NodeSignal,
    evidence: RegionEvidence,
    name: string | undefined,
): boolean => {
    if (evidence.shellLike || evidence.codeLike) return false;

    if (kind === 'dialog') {
        return signal.size >= 3;
    }

    if (kind === 'toolbar') {
        return signal.interactive >= 2;
    }

    if (kind === 'table') {
        if (signal.size < 6) return false;
        return signal.row >= 2 || evidence.explicitRole || evidence.explicitTag || evidence.explicitClass;
    }

    if (kind === 'list') {
        if (signal.size < 6) return false;
        const explicit = evidence.explicitRole || evidence.explicitTag || evidence.explicitClass;
        if (!explicit && signal.listItem < 4) return false;
        if (!explicit && signal.listItem < 6 && signal.interactive < 3) return false;
        if (!explicit && signal.heading >= signal.listItem) return false;
        return true;
    }

    if (kind === 'form') {
        if (signal.size < 5) return false;
        if (signal.field >= 1) return true;
        return signal.interactive >= 3 && Boolean(name);
    }

    if (kind !== 'panel') return false;
    if (signal.size < 10) return false;
    if (!name && signal.interactive < 2 && signal.field < 1) return false;
    if (!name && evidence.headingDominant && signal.interactive <= 2) return false;
    return true;
};

const collectNodeSignals = (
    node: UnifiedNode,
    signalById: Map<string, NodeSignal>,
): NodeSignal => {
    const self: NodeSignal = {
        size: 1,
        interactive: isInteractiveNode(node) ? 1 : 0,
        field: isFieldNode(node) ? 1 : 0,
        listItem: isListItemNode(node) ? 1 : 0,
        row: isRowNode(node) ? 1 : 0,
        heading: isHeadingNode(node) ? 1 : 0,
        prose: isProseNode(node) ? 1 : 0,
    };

    for (const child of node.children) {
        const childSignal = collectNodeSignals(child, signalById);
        self.size += childSignal.size;
        self.interactive += childSignal.interactive;
        self.field += childSignal.field;
        self.listItem += childSignal.listItem;
        self.row += childSignal.row;
        self.heading += childSignal.heading;
        self.prose += childSignal.prose;
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

const isHeadingNode = (node: UnifiedNode): boolean => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    return role === 'heading' || HEADING_TAGS.has(tag);
};

const isProseNode = (node: UnifiedNode): boolean => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    return PROSE_ROLES.has(role) || PROSE_TAGS.has(tag);
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

const isTableLikeNode = (role: string, tag: string, cls: string): boolean => {
    if (role === 'table' || role === 'grid' || role === 'treegrid' || role === 'rowgroup') return true;
    if (tag === 'table' || tag === 'thead' || tag === 'tbody') return true;
    if (TABLE_KEYWORDS.some((keyword) => cls.includes(keyword))) return true;
    return false;
};

const isTableAtomicNode = (role: string, tag: string): boolean => {
    if (TABLE_ATOMIC_ROLES.has(role)) return true;
    if (TABLE_ATOMIC_TAGS.has(tag)) return true;
    return false;
};

const isPaginationLikeNode = (role: string, tag: string, cls: string): boolean => {
    if (!PAGINATION_CLASS_HINTS.some((hint) => cls.includes(hint))) return false;
    if (PAGINATION_TAGS.has(tag)) return true;
    if (PAGINATION_ROLES.has(role)) return true;
    return false;
};

const hasDenseRowChildren = (node: UnifiedNode): boolean => {
    if (node.children.length < 2) return false;
    let rowLikeCount = 0;
    for (const child of node.children) {
        const role = normalizeLower(child.role);
        const tag = normalizeLower(getNodeAttr(child, 'tag') || getNodeAttr(child, 'tagName'));
        if (role === 'row' || role === 'listitem' || tag === 'tr') {
            rowLikeCount += 1;
        }
    }
    return rowLikeCount >= 2;
};

const isCodeLikeNode = (role: string, tag: string, cls: string): boolean => {
    if (CODE_ROLES.has(role) || CODE_TAGS.has(tag)) return true;
    if (CODE_CLASS_HINTS.some((hint) => cls.includes(hint))) return true;
    return false;
};

const walk = (node: UnifiedNode, visitor: (node: UnifiedNode) => void) => {
    visitor(node);
    for (const child of node.children) {
        walk(child, visitor);
    }
};

const normalizeLower = (value: string | undefined): string => (value || '').trim().toLowerCase();

const PANEL_ROLES = new Set(['region', 'complementary', 'contentinfo']);
const SHELL_ROLES = new Set(['root', 'main', 'body', 'document', 'application', 'webarea']);
const TABLE_KEYWORDS = ['table', 'grid', 'datatable', 'data-table'];
const TABLE_ATOMIC_ROLES = new Set(['row', 'cell', 'gridcell', 'rowheader', 'columnheader']);
const TABLE_ATOMIC_TAGS = new Set(['tr', 'td', 'th']);
const PAGINATION_CLASS_HINTS = ['pagination', 'pager'];
const PAGINATION_TAGS = new Set(['ul', 'ol', 'nav']);
const PAGINATION_ROLES = new Set(['list', 'navigation']);
const CODE_ROLES = new Set(['code']);
const CODE_TAGS = new Set(['code', 'pre']);
const CODE_CLASS_HINTS = ['language-', 'code-block', 'highlight', 'hljs', 'shiki', 'vp-code'];
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
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const PROSE_ROLES = new Set(['paragraph', 'article', 'section']);
const PROSE_TAGS = new Set(['p', 'article', 'section']);
