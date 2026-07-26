import {
    getNodeAttr,
    getNodeContent,
    normalizeText,
} from '../../runner/steps/executors/snapshot/core/runtime_store';
import type {
    BBox,
    EntityIndex,
    EntityKind,
    FinalEntityView,
    UnifiedNode,
    SnapshotResult,
} from '../../runner/steps/executors/snapshot/core/types';
import type { EntityRuleExpect } from '../../runner/steps/executors/snapshot/entity_rules/types';
import type { PersistentTargetDraft } from './types';
import type {
    PickCandidate,
    PickCandidateEntityRef,
    PickCandidateLevel,
    PickFingerprint,
    PickResolution,
    PickPoint,
} from './runtime_types';

const INTERACTIVE_ROLES = new Set([
    'button',
    'link',
    'textbox',
    'combobox',
    'checkbox',
    'radio',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'tab',
    'option',
    'switch',
    'searchbox',
    'spinbutton',
    'slider',
    'treeitem',
    'listbox',
]);

const ROW_ROLES = new Set(['row', 'listitem', 'treeitem', 'rowheader']);
const CELL_ROLES = new Set(['cell', 'gridcell', 'columnheader']);

const normalizeLower = (value: string | undefined): string =>
    (normalizeText(value) || '').toLowerCase();

export const buildNodeIndex = (root: UnifiedNode): Map<string, UnifiedNode> => {
    const map = new Map<string, UnifiedNode>();
    const stack: UnifiedNode[] = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        if (!node) {
            break;
        }
        map.set(node.id, node);
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
            stack.push(node.children[index]);
        }
    }
    return map;
};

export const buildParentById = (root: UnifiedNode): Map<string, string | null> => {
    const parentById = new Map<string, string | null>();
    const stack: Array<{ node: UnifiedNode; parentId: string | null }> = [
        { node: root, parentId: null },
    ];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {
            break;
        }
        parentById.set(current.node.id, current.parentId);
        for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
            stack.push({ node: current.node.children[index], parentId: current.node.id });
        }
    }
    return parentById;
};

export const isDescendantOrSelf = (
    nodeId: string,
    ancestorId: string,
    parentById: Map<string, string | null>,
): boolean => {
    let cursor: string | null = nodeId;
    while (cursor) {
        if (cursor === ancestorId) {
            return true;
        }
        cursor = parentById.get(cursor) || null;
    }
    return false;
};

export const lowestCommonAncestor = (
    a: string | undefined,
    b: string | undefined,
    parentById: Map<string, string | null>,
): string | undefined => {
    if (!a || !b) {
        return a || b;
    }
    const ancestorsOfA = new Set<string>();
    let cursor: string | null = a;
    while (cursor) {
        ancestorsOfA.add(cursor);
        cursor = parentById.get(cursor) || null;
    }
    cursor = b;
    while (cursor) {
        if (ancestorsOfA.has(cursor)) {
            return cursor;
        }
        cursor = parentById.get(cursor) || null;
    }
    return undefined;
};

const containsPoint = (bbox: BBox, point: PickPoint): boolean =>
    point.x >= bbox.x &&
    point.x <= bbox.x + bbox.width &&
    point.y >= bbox.y &&
    point.y <= bbox.y + bbox.height;

const nodeTagName = (node: UnifiedNode): string =>
    normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));

const classTokensOf = (node: UnifiedNode): string[] => {
    const raw = normalizeLower(getNodeAttr(node, 'class'));
    if (!raw) {
        return [];
    }
    return raw.split(/\s+/).filter((token) => token.length > 0);
};

const looselyMatchesFingerprint = (node: UnifiedNode, fingerprint: PickFingerprint): boolean => {
    const tag = nodeTagName(node);
    if (tag && fingerprint.tagName && tag === normalizeLower(fingerprint.tagName)) {
        return true;
    }
    const tokens = new Set(classTokensOf(node));
    return fingerprint.classTokens.some((token) => tokens.has(normalizeLower(token)));
};

const findAncestorByTag = (
    snapshot: SnapshotResult,
    nodeId: string,
    tagName: string,
    maxDepth: number,
): string | null => {
    const parentById = buildParentById(snapshot.root);
    const target = normalizeLower(tagName);
    let cursor: string | null = nodeId;
    let depth = 0;
    while (cursor && depth <= maxDepth) {
        const node = snapshot.nodeIndex[cursor];
        if (node && nodeTagName(node) === target) {
            return cursor;
        }
        cursor = parentById.get(cursor) || null;
        depth += 1;
    }
    return null;
};

const scoreTagClassText = (node: UnifiedNode, fingerprint: PickFingerprint): number => {
    let score = 0;
    const tag = nodeTagName(node);
    if (tag && fingerprint.tagName && tag === normalizeLower(fingerprint.tagName)) {
        score += 3;
    }
    const tokens = new Set(classTokensOf(node));
    if (fingerprint.classTokens.some((token) => tokens.has(normalizeLower(token)))) {
        score += 2;
    }
    const text = normalizeLower(node.name || getNodeContent(node));
    if (fingerprint.text && text.includes(normalizeLower(fingerprint.text))) {
        score += 1;
    }
    return score;
};

const matchByTagClassText = (
    snapshot: SnapshotResult,
    fingerprint: PickFingerprint,
): string | null => {
    let bestNodeId: string | null = null;
    let bestScore = 0;
    for (const node of Object.values(snapshot.nodeIndex)) {
        const score = scoreTagClassText(node, fingerprint);
        if (score > bestScore) {
            bestScore = score;
            bestNodeId = node.id;
        }
    }
    return bestScore >= 2 ? bestNodeId : null;
};

export const resolveClickedNode = (
    snapshot: SnapshotResult,
    fingerprint: PickFingerprint,
): PickResolution => {
    const { point } = fingerprint;
    let bestNodeId: string | null = null;
    let bestArea = Number.POSITIVE_INFINITY;
    for (const [nodeId, bbox] of Object.entries(snapshot.bboxIndex)) {
        if (!containsPoint(bbox, point)) {
            continue;
        }
        const area = bbox.width * bbox.height;
        if (area < bestArea) {
            bestArea = area;
            bestNodeId = nodeId;
        }
    }

    if (bestNodeId) {
        const node = snapshot.nodeIndex[bestNodeId];
        if (node && looselyMatchesFingerprint(node, fingerprint)) {
            return { nodeId: bestNodeId, reason: 'bbox', matchedNodeIds: [bestNodeId] };
        }
        if (fingerprint.tagName) {
            const up = findAncestorByTag(snapshot, bestNodeId, fingerprint.tagName, 2);
            if (up) {
                return { nodeId: up, reason: 'bbox', matchedNodeIds: [up] };
            }
        }
        return { nodeId: bestNodeId, reason: 'bbox', matchedNodeIds: [bestNodeId] };
    }

    const fallback = matchByTagClassText(snapshot, fingerprint);
    if (fallback) {
        return { nodeId: fallback, reason: 'fallback', matchedNodeIds: [fallback] };
    }
    return { nodeId: null, reason: 'none', matchedNodeIds: [] };
};

type EntityRootEntry = {
    entityId: string;
    nodeId: string;
    kind: EntityKind;
    type: 'region' | 'group';
    name?: string;
};

const buildEntityRootIndex = (entityIndex: EntityIndex): Map<string, EntityRootEntry[]> => {
    const map = new Map<string, EntityRootEntry[]>();
    for (const entity of Object.values(entityIndex.entities)) {
        const nodeId = entity.type === 'region' ? entity.nodeId : entity.containerId;
        const entry: EntityRootEntry = {
            entityId: entity.id,
            nodeId,
            kind: entity.kind,
            type: entity.type,
            name: entity.name,
        };
        const list = map.get(nodeId);
        if (list) {
            list.push(entry);
        } else {
            map.set(nodeId, [entry]);
        }
    }
    return map;
};

type FieldBindingMap = Map<
    string,
    { fieldKey: string; entityId: string; kind?: EntityKind; role: 'control' | 'label' | 'wrapper' }
>;

const buildFieldBindingMap = (
    snapshot: SnapshotResult,
    finalEntityView: FinalEntityView | undefined,
): FieldBindingMap => {
    const map: FieldBindingMap = new Map();
    if (!finalEntityView) {
        return map;
    }
    const parentById = buildParentById(snapshot.root);
    for (const entity of finalEntityView.entities) {
        for (const field of entity.formFields || []) {
            const control = field.controlNodeId;
            const label = field.labelNodeId;
            if (control) {
                map.set(control, {
                    fieldKey: field.fieldKey,
                    entityId: entity.id,
                    kind: entity.kind,
                    role: 'control',
                });
            }
            if (label) {
                map.set(label, {
                    fieldKey: field.fieldKey,
                    entityId: entity.id,
                    kind: entity.kind,
                    role: 'label',
                });
            }
            const wrapper = lowestCommonAncestor(control, label, parentById);
            if (wrapper && !map.has(wrapper)) {
                map.set(wrapper, {
                    fieldKey: field.fieldKey,
                    entityId: entity.id,
                    kind: entity.kind,
                    role: 'wrapper',
                });
            }
        }
    }
    return map;
};

const isInteractive = (node: UnifiedNode): boolean =>
    Boolean(node.control) || INTERACTIVE_ROLES.has(normalizeLower(node.role));

export const isStableClassToken = (token: string): boolean => {
    if (!token || token.length < 2 || token.length > 28) {
        return false;
    }
    if (!/[a-z]/i.test(token)) {
        return false;
    }
    if (/^\d/.test(token)) {
        return false;
    }
    if (/^(css|sc|rc|chakra|emotion|styled|jsx|next)-/i.test(token)) {
        return false;
    }
    if (/^[a-z0-9]+$/i.test(token) && token.length >= 6) {
        return false;
    }
    const suffixMatch = token.match(/^[a-z]+-([a-z0-9]+)$/i);
    if (suffixMatch) {
        const suffix = suffixMatch[1];
        if (suffix.length >= 5 && /[0-9]/.test(suffix) && /[a-z]/i.test(suffix)) {
            return false;
        }
    }
    if (/-\d{3,}/.test(token)) {
        return false;
    }
    if (/^[a-z]+_\d+$/i.test(token)) {
        return false;
    }
    return true;
};

const pickStableClass = (tokens: string[]): string | undefined => {
    const stable = tokens.filter(isStableClassToken);
    if (stable.length === 0) {
        return undefined;
    }
    return stable.sort((left, right) => right.length - left.length)[0];
};

type Classification = {
    level: PickCandidateLevel;
    entityRef?: PickCandidateEntityRef;
    fieldKey?: string;
    actionIntent?: string;
};

const classifyNode = (
    nodeId: string,
    snapshot: SnapshotResult,
    entityRootIndex: Map<string, EntityRootEntry[]>,
    fieldMap: FieldBindingMap,
): Classification | null => {
    const node = snapshot.nodeIndex[nodeId];
    if (!node) {
        return null;
    }

    const roots = entityRootIndex.get(nodeId);
    if (roots && roots.length > 0) {
        const root = roots[0];
        return {
            level: root.type === 'region' ? 'region' : 'group',
            entityRef: {
                entityId: root.entityId,
                nodeId: root.nodeId,
                kind: root.kind,
                type: root.type,
            },
        };
    }

    const role = normalizeLower(node.role);

    if (ROW_ROLES.has(role)) {
        return { level: 'row' };
    }

    if (CELL_ROLES.has(role)) {
        return { level: 'field' };
    }

    const field = fieldMap.get(nodeId);
    if (field && field.role === 'wrapper') {
        return { level: 'field', fieldKey: field.fieldKey };
    }

    const isFieldWrapper = classTokensOf(node).some(
        (token) =>
            token === 'ant-form-item' ||
            token.startsWith('ant-form-item-') ||
            /form-?item|form-?field/i.test(token),
    );
    if (isFieldWrapper) {
        return { level: 'field' };
    }

    if (isInteractive(node)) {
        const intent = inferActionIntent(node);
        return {
            level: 'control',
            fieldKey: field?.role === 'control' ? field.fieldKey : undefined,
            actionIntent: intent,
        };
    }

    if (field && field.role === 'label') {
        return { level: 'control', fieldKey: field.fieldKey };
    }

    return null;
};

const inferActionIntent = (node: UnifiedNode): string | undefined => {
    const text = normalizeLower(node.name || getNodeContent(node)).replace(/\s+/g, '');
    if (!text) {
        return undefined;
    }
    if (text.includes('提交') || text.includes('submit')) {
        return 'submit';
    }
    if (text.includes('编辑') || text.includes('edit')) {
        return 'edit';
    }
    if (text.includes('删除') || text.includes('delete')) {
        return 'delete';
    }
    if (text.includes('保存') || text.includes('save')) {
        return 'save';
    }
    if (text.includes('查询') || text.includes('搜索') || text.includes('search')) {
        return 'search';
    }
    return undefined;
};

const hasSemanticName = (node: UnifiedNode): boolean => {
    const name = normalizeText(node.name || getNodeContent(node));
    return Boolean(name) && (name || '').length <= 32;
};

export const scoreCandidate = (candidate: PickCandidate, node: UnifiedNode): number => {
    const levelBase: Record<PickCandidateLevel, number> = {
        region: 100,
        group: 90,
        field: 80,
        control: 70,
        row: 60,
        unknown: 20,
    };
    let score = levelBase[candidate.level];
    if (hasSemanticName(node)) {
        score += 5;
    }
    const stable = pickStableClass(classTokensOf(node));
    if (stable) {
        score += 5;
    }
    if (candidate.entityRef) {
        score += 3;
    }
    if (candidate.fieldKey || candidate.actionIntent) {
        score += 4;
    }
    return score;
};

const nodeMatchesTarget = (node: UnifiedNode, target: PersistentTargetDraft): boolean => {
    if (target.classContains) {
        const cls = normalizeLower(getNodeAttr(node, 'class'));
        if (!cls.includes(normalizeLower(target.classContains))) {
            return false;
        }
    }
    if (target.textContains) {
        const text = normalizeLower(node.name || getNodeContent(node));
        if (!text.includes(normalizeLower(target.textContains))) {
            return false;
        }
    }
    if (target.ariaContains) {
        const aria = normalizeLower(
            [
                getNodeAttr(node, 'aria-label'),
                getNodeAttr(node, 'aria-labelledby'),
                getNodeAttr(node, 'title'),
            ]
                .map((value) => normalizeText(value))
                .filter((value): value is string => Boolean(value))
                .join(' '),
        );
        if (!aria.includes(normalizeLower(target.ariaContains))) {
            return false;
        }
    }
    if (target.nameContains) {
        const name = normalizeLower(node.name);
        if (!name.includes(normalizeLower(target.nameContains))) {
            return false;
        }
    }
    return true;
};

export const countMatches = (
    snapshot: SnapshotResult,
    target: PersistentTargetDraft,
    scopeNodeIds?: Set<string>,
): string[] => {
    const parentById = buildParentById(snapshot.root);
    const matched: string[] = [];
    for (const node of Object.values(snapshot.nodeIndex)) {
        if (scopeNodeIds && scopeNodeIds.size > 0) {
            let inScope = false;
            for (const scopeId of scopeNodeIds) {
                if (isDescendantOrSelf(node.id, scopeId, parentById)) {
                    inScope = true;
                    break;
                }
            }
            if (!inScope) {
                continue;
            }
        }
        if (nodeMatchesTarget(node, target)) {
            matched.push(node.id);
        }
    }
    return matched.sort((left, right) => left.localeCompare(right));
};

const countEntityMatches = (
    entityIndex: EntityIndex,
    kind: EntityKind,
    nameContains?: string,
): string[] => {
    const needle = normalizeLower(nameContains);
    const out: string[] = [];
    for (const entity of Object.values(entityIndex.entities)) {
        if (entity.kind !== kind) {
            continue;
        }
        if (needle) {
            const name = normalizeLower(entity.name);
            if (!name.includes(needle)) {
                continue;
            }
        }
        out.push(entity.type === 'region' ? entity.nodeId : entity.containerId);
    }
    return out;
};

type Proposal = {
    proposedTargets: PersistentTargetDraft[];
    matchCount: number;
    matchedNodeIds: string[];
    stabilityHint: 'stable' | 'fragile';
    expect: EntityRuleExpect;
};

const proposeForNodeCandidate = (
    snapshot: SnapshotResult,
    candidate: PickCandidate,
    enclosingEntityNodeId: string | undefined,
): Proposal => {
    const node = snapshot.nodeIndex[candidate.nodeId];
    const target: PersistentTargetDraft = {};
    let stable = false;
    if (node) {
        const stableClass = pickStableClass(classTokensOf(node));
        if (stableClass) {
            target.classContains = stableClass;
            stable = true;
        }
        const aria = normalizeText(getNodeAttr(node, 'aria-label') || getNodeAttr(node, 'title'));
        if (aria && aria.length <= 32) {
            target.ariaContains = aria;
            stable = true;
        }
        const text = normalizeText(node.name || getNodeContent(node));
        if (
            text &&
            text.length <= 16 &&
            (candidate.level === 'control' || candidate.actionIntent)
        ) {
            target.textContains = text;
        }
    }
    const scope = enclosingEntityNodeId ? new Set([enclosingEntityNodeId]) : undefined;
    const matched = countMatches(snapshot, target, scope);
    const matchCount = matched.length;
    const expect: EntityRuleExpect = matchCount > 1 ? 'one_or_more' : 'unique';
    const stabilityHint: 'stable' | 'fragile' =
        stable || Boolean(target.classContains) ? 'stable' : 'fragile';
    return {
        proposedTargets: [target],
        matchCount,
        matchedNodeIds: matched,
        stabilityHint,
        expect,
    };
};

const proposeForEntityCandidate = (
    snapshot: SnapshotResult,
    candidate: PickCandidate,
): Proposal => {
    const kind = candidate.entityRef?.kind;
    const name = snapshot.nodeIndex[candidate.nodeId]?.name;
    const target: PersistentTargetDraft = kind ? { kind } : {};
    if (normalizeText(name)) {
        target.nameContains = normalizeText(name);
    }
    const matched = kind ? countEntityMatches(snapshot.entityIndex, kind, target.nameContains) : [];
    return {
        proposedTargets: [target],
        matchCount: matched.length,
        matchedNodeIds: matched,
        stabilityHint: 'stable',
        expect: 'unique',
    };
};

export const proposeRuleCandidates = (
    snapshot: SnapshotResult,
    candidate: PickCandidate,
    enclosingEntityNodeId?: string,
): Proposal => {
    if (candidate.level === 'region' || candidate.level === 'group') {
        return proposeForEntityCandidate(snapshot, candidate);
    }
    return proposeForNodeCandidate(snapshot, candidate, enclosingEntityNodeId);
};

export const buildCandidateChain = (
    snapshot: SnapshotResult,
    finalEntityView: FinalEntityView | undefined,
    clickedNodeId: string | null,
): PickCandidate[] => {
    const parentById = buildParentById(snapshot.root);
    const entityRootIndex = buildEntityRootIndex(snapshot.entityIndex);
    const fieldMap = buildFieldBindingMap(snapshot, finalEntityView);

    if (!clickedNodeId) {
        return [
            {
                level: 'unknown',
                nodeId: '',
                score: 0,
                matchCount: 0,
                matchedNodeIds: [],
            },
        ];
    }

    const raw: PickCandidate[] = [];
    let cursor: string | null = clickedNodeId;
    while (cursor) {
        const node = snapshot.nodeIndex[cursor];
        if (!node) {
            break;
        }
        const classification = classifyNode(cursor, snapshot, entityRootIndex, fieldMap);
        if (classification) {
            const candidate: PickCandidate = {
                level: classification.level,
                nodeId: cursor,
                role: normalizeText(node.role),
                text: normalizeText(node.name || getNodeContent(node)),
                fieldKey: classification.fieldKey,
                actionIntent: classification.actionIntent,
                entityRef: classification.entityRef,
                score: 0,
            };
            candidate.score = scoreCandidate(candidate, node);
            raw.push(candidate);
        }
        cursor = parentById.get(cursor) || null;
    }

    const chain: PickCandidate[] = [];
    let lastLevel: PickCandidateLevel | null = null;
    let lastEntityId: string | undefined = undefined;
    let enclosingEntityNodeId: string | undefined = undefined;
    for (const candidate of raw) {
        if (
            candidate.level === lastLevel &&
            (candidate.level === 'control' ||
                candidate.level === 'field' ||
                candidate.level === 'row' ||
                candidate.entityRef?.entityId === lastEntityId)
        ) {
            continue;
        }
        if (candidate.entityRef && !enclosingEntityNodeId) {
            enclosingEntityNodeId = candidate.nodeId;
        }
        chain.push(candidate);
        lastLevel = candidate.level;
        lastEntityId = candidate.entityRef?.entityId;
    }

    let currentEnclosing = enclosingEntityNodeId;
    for (const candidate of chain) {
        const proposal = proposeRuleCandidates(snapshot, candidate, currentEnclosing);
        candidate.matchCount = proposal.matchCount;
        candidate.matchedNodeIds = proposal.matchedNodeIds;
        candidate.proposedTargets = proposal.proposedTargets;
        candidate.stabilityHint = proposal.stabilityHint;
        candidate.expect = proposal.expect;
        candidate.enclosingEntityNodeId = currentEnclosing;
        if (candidate.entityRef && !currentEnclosing) {
            currentEnclosing = candidate.nodeId;
        }
    }

    return chain;
};

export const pickFromFingerprint = (
    snapshot: SnapshotResult,
    finalEntityView: FinalEntityView | undefined,
    fingerprint: PickFingerprint,
): { candidateChain: PickCandidate[]; matchedNodeIds: string[]; resolution: PickResolution } => {
    const resolution = resolveClickedNode(snapshot, fingerprint);
    const candidateChain = buildCandidateChain(snapshot, finalEntityView, resolution.nodeId);
    return {
        candidateChain,
        matchedNodeIds: resolution.matchedNodeIds,
        resolution,
    };
};
