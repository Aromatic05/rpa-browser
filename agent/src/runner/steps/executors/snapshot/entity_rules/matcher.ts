import { getNodeAttr, getNodeContent, normalizeText } from '../core/runtime_store';
import { getLogger } from '../../../../../logging/logger';
import type { EntityKind, GroupEntity, RegionEntity, UnifiedNode } from '../core/types';
import type {
    EntityCandidate,
    EntityMatchContext,
    EntityMatchRule,
    NormalizedEntityRuleBundle,
    ResolvedRuleBinding,
    RuleBindingEntityRef,
} from './types';

const log = getLogger('entity');

export const matchEntityRules = (
    bundle: NormalizedEntityRuleBundle,
    context: EntityMatchContext,
): Record<string, ResolvedRuleBinding> => {
    const root = context.root as UnifiedNode;
    const nodes = buildNodeIndex(root);
    const parentById = buildParentById(root);

    const ruleResults: Record<string, ResolvedRuleBinding> = {};
    log.info('entity.rules.match.start', {
        profile: bundle.id,
        ruleCount: bundle.matchRules.length,
    });

    for (const rule of bundle.matchRules) {
        const scopeNodeIds = resolveScopeNodeIds(rule, ruleResults);
        const candidates = collectCandidates(rule, context.entityIndex, nodes);
        const matched = candidates.filter((candidate) => matchesRule(rule, candidate, nodes, scopeNodeIds, parentById));
        const matchedEntityRefs = matched
            .filter((candidate): candidate is Extract<EntityCandidate, { source: 'region' | 'group' }> => candidate.source !== 'node')
            .map((candidate) => toEntityRef(candidate.entity));
        const matchedNodeIds = Array.from(new Set(matched.map((candidate) => candidate.nodeId))).sort((left, right) => left.localeCompare(right));
        const count = matchedNodeIds.length;

        const ok = rule.expect === 'unique' ? count === 1 : count >= 1;
        if (ok) {
            log.info('entity.rules.match.hit', {
                profile: bundle.id,
                ruleId: rule.ruleId,
                source: rule.source,
                matchedCount: count,
                nodeIds: matchedNodeIds.slice(0, 5),
            });
        } else {
            log.info('entity.rules.match.miss', {
                profile: bundle.id,
                ruleId: rule.ruleId,
                source: rule.source,
                expect: rule.expect,
                matchedCount: count,
            });
        }
        ruleResults[rule.ruleId] = {
            ruleId: rule.ruleId,
            source: rule.source,
            expect: rule.expect,
            matchedEntityRefs,
            matchedNodeIds,
            ok,
        };
    }

    return ruleResults;
};

const collectCandidates = (
    rule: EntityMatchRule,
    entityIndex: EntityMatchContext['entityIndex'],
    nodes: Map<string, UnifiedNode>,
): EntityCandidate[] => {
    if (rule.source === 'node') {
        return Array.from(nodes.values()).map((node) => ({
            source: 'node' as const,
            nodeId: node.id,
            name: normalizeText(node.name || getNodeContent(node)),
        }));
    }

    const entities = Object.values(entityIndex.entities);
    const out: EntityCandidate[] = [];

    for (const entity of entities) {
        if (rule.source === 'region' && entity.type === 'region') {
            out.push({ source: 'region', entity, nodeId: entity.nodeId });
            continue;
        }
        if (rule.source === 'group' && entity.type === 'group') {
            out.push({ source: 'group', entity, nodeId: entity.containerId });
        }
    }

    return out;
};

const matchesRule = (
    rule: EntityMatchRule,
    candidate: EntityCandidate,
    nodes: Map<string, UnifiedNode>,
    scopeNodeIds: Set<string> | null,
    parentById: Map<string, string | null>,
): boolean => {
    const node = nodes.get(candidate.nodeId);
    if (!node) return false;

    if (scopeNodeIds && scopeNodeIds.size > 0) {
        let inScope = false;
        for (const scopeNodeId of scopeNodeIds) {
            if (isDescendantOrSelf(candidate.nodeId, scopeNodeId, parentById)) {
                inScope = true;
                break;
            }
        }
        if (!inScope) return false;
    }

    const match = rule.match;
    if (match.kind) {
        const candidateKind = resolveCandidateKind(candidate);
        if (!candidateKind || candidateKind !== match.kind) return false;
    }

    if (match.nameContains) {
        const nameText = normalizeLower(resolveCandidateName(candidate, node));
        const needle = normalizeLower(match.nameContains);
        if (!nameText.includes(needle)) return false;
    }

    if (match.keyHint) {
        const keyHintText = normalizeLower(resolveKeyHintText(candidate));
        const headerNeedles = (match.keyHint.headerContainsAll || []).map(normalizeLower).filter(Boolean);
        if (headerNeedles.length > 0 && !headerNeedles.every((needle) => keyHintText.includes(needle))) return false;

        const primaryNeedles = (match.keyHint.primaryKeyCandidatesContains || []).map(normalizeLower).filter(Boolean);
        if (primaryNeedles.length > 0 && !primaryNeedles.every((needle) => keyHintText.includes(needle))) return false;
    }

    if (match.relation === 'pagination') {
        if (!hasPaginationRelation(node)) return false;
    }

    if (match.classContains) {
        const classText = normalizeLower(getNodeAttr(node, 'class'));
        if (!classText.includes(normalizeLower(match.classContains))) return false;
    }

    if (match.textContains) {
        const text = normalizeLower(node.name || getNodeContent(node));
        if (!text.includes(normalizeLower(match.textContains))) return false;
    }

    if (match.ariaContains) {
        const aria = normalizeLower([
            getNodeAttr(node, 'aria-label'),
            getNodeAttr(node, 'aria-labelledby'),
            getNodeAttr(node, 'aria-describedby'),
            getNodeAttr(node, 'title'),
        ]
            .map((value) => normalizeText(value))
            .filter((value): value is string => Boolean(value))
            .join(' '));
        if (!aria.includes(normalizeLower(match.ariaContains))) return false;
    }

    return true;
};

const hasPaginationRelation = (node: UnifiedNode): boolean => {
    const stack = [node];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) break;

        const role = normalizeLower(current.role);
        const tag = normalizeLower(getNodeAttr(current, 'tag') || getNodeAttr(current, 'tagName'));
        const cls = normalizeLower(getNodeAttr(current, 'class'));
        const aria = normalizeLower(getNodeAttr(current, 'aria-label'));
        if (
            cls.includes('pagination') ||
            cls.includes('pager') ||
            aria.includes('pagination') ||
            aria.includes('pager') ||
            ((role === 'navigation' || role === 'list') && (tag === 'nav' || tag === 'ul' || tag === 'ol'))
        ) {
            return true;
        }

        for (const child of current.children) {
            stack.push(child);
        }
    }

    return false;
};

const resolveScopeNodeIds = (
    rule: EntityMatchRule,
    results: Record<string, ResolvedRuleBinding>,
): Set<string> | null => {
    if (!rule.within) return null;
    const within = results[rule.within];
    if (!within) return new Set();

    const nodeIds = new Set<string>(within.matchedNodeIds);
    for (const ref of within.matchedEntityRefs) {
        nodeIds.add(ref.nodeId);
    }

    return nodeIds;
};

const toEntityRef = (entity: RegionEntity | GroupEntity): RuleBindingEntityRef => ({
    entityId: entity.id,
    nodeId: entity.type === 'region' ? entity.nodeId : entity.containerId,
    kind: entity.kind,
    type: entity.type,
});

const resolveCandidateKind = (candidate: EntityCandidate): EntityKind | undefined => {
    if (candidate.source === 'node') return candidate.kind;
    return candidate.entity.kind;
};

const resolveCandidateName = (candidate: EntityCandidate, node: UnifiedNode): string | undefined => {
    if (candidate.source !== 'node') {
        return normalizeText(candidate.entity.name || node.name || getNodeContent(node));
    }
    return normalizeText(candidate.name || node.name || getNodeContent(node));
};

const resolveKeyHintText = (candidate: EntityCandidate): string => {
    if (candidate.source === 'node') return '';
    const keyHint = candidate.entity.keyHint;
    if (!keyHint) return '';
    return [keyHint.name, ...(keyHint.sampleValues || [])]
        .map((value) => normalizeText(value))
        .filter((value): value is string => Boolean(value))
        .join(' ')
        .toLowerCase();
};

const buildNodeIndex = (root: UnifiedNode): Map<string, UnifiedNode> => {
    const map = new Map<string, UnifiedNode>();
    const stack: UnifiedNode[] = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        if (!node) break;
        map.set(node.id, node);
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
            stack.push(node.children[index]);
        }
    }
    return map;
};

const buildParentById = (root: UnifiedNode): Map<string, string | null> => {
    const parentById = new Map<string, string | null>();
    const stack: Array<{ node: UnifiedNode; parentId: string | null }> = [{ node: root, parentId: null }];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) break;
        parentById.set(current.node.id, current.parentId);
        for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
            stack.push({
                node: current.node.children[index],
                parentId: current.node.id,
            });
        }
    }
    return parentById;
};

const isDescendantOrSelf = (nodeId: string, ancestorId: string, parentById: Map<string, string | null>): boolean => {
    let cursor: string | null = nodeId;
    while (cursor) {
        if (cursor === ancestorId) return true;
        cursor = parentById.get(cursor) || null;
    }
    return false;
};

const normalizeLower = (value: string | undefined): string => normalizeText(value)?.toLowerCase() || '';
