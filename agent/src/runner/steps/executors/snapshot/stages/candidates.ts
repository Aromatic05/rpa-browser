import { getNodeAttr, getNodeContent, normalizeText } from '../core/runtime_store';
import type { EntityKind, UnifiedNode } from '../core/types';
import type { GroupDetection } from './groups';
import type { NodeSignal, RegionDetection } from './regions';

type CandidateSource = 'group' | 'region';

type CandidateFeatures = {
    semanticScore: number;
    dominantStructureScore: number;
    interactionScore: number;
    boundaryScore: number;
    minimalityScore: number;
    prosePenalty: number;
    docNoisePenalty: number;
    redundancyPenalty: number;
    nestedSameTypePenalty: number;
    confidence: number;
};

type CandidateEvidence = {
    explicitRole: boolean;
    explicitTag: boolean;
    explicitClass: boolean;
    hasName: boolean;
    shellLike: boolean;
    codeLike: boolean;
    headingDominant: boolean;
    explicitness: number;
};

type CandidateSignal = {
    size: number;
    interactive: number;
    field: number;
    listItem: number;
    row: number;
    heading: number;
    prose: number;
    itemCount?: number;
    slotCount?: number;
    stableRate?: number;
    interactiveItemRate?: number;
    keyCoverage?: number;
    keyUniqueness?: number;
};

export type StructureCandidate = {
    nodeId: string;
    source: CandidateSource;
    kind: EntityKind;
    name?: string;
    score: number;
    depth: number;
    features: CandidateFeatures;
    evidence: CandidateEvidence;
    signal: CandidateSignal;
    group?: GroupDetection;
    region?: RegionDetection;
};

type CandidateSelectionResult = {
    candidates: StructureCandidate[];
    groups: GroupDetection[];
    regions: RegionDetection[];
};

type CandidateSourceInput = {
    groups: GroupDetection[];
    regions: RegionDetection[];
};

type TreeSignal = NodeSignal;

type TreeContext = {
    nodeById: Map<string, UnifiedNode>;
    parentById: Map<string, UnifiedNode | null>;
    depthById: Map<string, number>;
    signalById: Map<string, TreeSignal>;
    enterById: Map<string, number>;
    exitById: Map<string, number>;
};

type ConflictDecision = {
    dropCandidate?: boolean;
    dropExisting?: boolean;
    candidateRedundancyPenalty?: number;
    candidateNestedPenalty?: number;
    note?: string;
};

export const buildStructureCandidates = (
    root: UnifiedNode,
    input: CandidateSourceInput,
): StructureCandidate[] => {
    const context = buildTreeContext(root);
    const candidates: StructureCandidate[] = [];

    for (const region of input.regions) {
        const node = context.nodeById.get(region.nodeId);
        if (!node) {continue;}
        const signal = context.signalById.get(region.nodeId) || region.signal;
        const depth = context.depthById.get(region.nodeId) || 0;
        const features = scoreRegionFeatures(region, node, signal, depth);
        const evidence = buildRegionCandidateEvidence(region, node, features);
        candidates.push({
            nodeId: region.nodeId,
            source: 'region',
            kind: region.kind,
            name: region.name,
            depth,
            score: scoreCandidate(features),
            features,
            evidence,
            signal,
            region,
        });
    }

    for (const group of input.groups) {
        const node = context.nodeById.get(group.containerId);
        if (!node) {continue;}
        const containerSignal = context.signalById.get(group.containerId);
        const depth = context.depthById.get(group.containerId) || 0;
        const signal: CandidateSignal = {
            size: containerSignal?.size || 0,
            interactive: containerSignal?.interactive || 0,
            field: containerSignal?.field || 0,
            listItem: containerSignal?.listItem || 0,
            row: containerSignal?.row || 0,
            heading: containerSignal?.heading || 0,
            prose: containerSignal?.prose || 0,
            itemCount: group.signal.itemCount,
            slotCount: group.signal.slotCount,
            stableRate: group.signal.stableRate,
            interactiveItemRate: group.signal.interactiveItemRate,
            keyCoverage: group.signal.keyCoverage,
            keyUniqueness: group.signal.keyUniqueness,
        };
        const features = scoreGroupFeatures(group, node, signal, depth);
        const evidence = buildGroupCandidateEvidence(group, node, features);
        candidates.push({
            nodeId: group.containerId,
            source: 'group',
            kind: group.kind,
            name: group.name,
            depth,
            score: scoreCandidate(features),
            features,
            evidence,
            signal,
            group,
        });
    }

    return candidates;
};

export const selectStructureCandidates = (
    root: UnifiedNode,
    candidates: StructureCandidate[],
): CandidateSelectionResult => {
    return runSelection(root, candidates);
};

const runSelection = (
    root: UnifiedNode,
    candidates: StructureCandidate[],
): CandidateSelectionResult => {
    const context = buildTreeContext(root);
    const sorted = [...candidates].sort(compareCandidatePriority);
    const kept: StructureCandidate[] = [];

    for (const candidate of sorted) {
        if (!passesScoreThreshold(candidate)) {
            continue;
        }
        let dropped = false;

        for (let index = 0; index < kept.length; index += 1) {
            const existing = kept[index];
            const decision = resolveConflict(candidate, existing, context);
            if (decision.dropCandidate) {
                dropped = true;
                break;
            }
            if (decision.dropExisting) {
                kept.splice(index, 1);
                index -= 1;
                continue;
            }
            if (decision.candidateRedundancyPenalty || decision.candidateNestedPenalty) {
                applyPenalty(candidate, decision.candidateRedundancyPenalty || 0, decision.candidateNestedPenalty || 0);
                if (!passesScoreThreshold(candidate)) {
                    dropped = true;
                    break;
                }
            }
        }

        if (dropped) {continue;}
        kept.push(candidate);
    }

    const { kept: capped } = capCandidates(kept.sort(compareCandidatePriority), context);

    const regions: RegionDetection[] = [];
    const groups: GroupDetection[] = [];
    for (const candidate of capped) {
        if (candidate.source === 'region' && candidate.region) {
            regions.push(candidate.region);
            continue;
        }
        if (candidate.source === 'group' && candidate.group) {
            groups.push(candidate.group);
        }
    }

    return { candidates: capped, groups, regions };
};

const buildTreeContext = (root: UnifiedNode): TreeContext => {
    const nodeById = new Map<string, UnifiedNode>();
    const parentById = new Map<string, UnifiedNode | null>();
    const depthById = new Map<string, number>();
    const signalById = new Map<string, TreeSignal>();
    const enterById = new Map<string, number>();
    const exitById = new Map<string, number>();
    let clock = 0;

    const visit = (node: UnifiedNode, depth: number, parent: UnifiedNode | null): TreeSignal => {
        nodeById.set(node.id, node);
        parentById.set(node.id, parent);
        depthById.set(node.id, depth);
        enterById.set(node.id, clock);
        clock += 1;

        const self: TreeSignal = {
            size: 1,
            interactive: isInteractiveNode(node) ? 1 : 0,
            field: isFieldNode(node) ? 1 : 0,
            listItem: isListItemNode(node) ? 1 : 0,
            row: isRowNode(node) ? 1 : 0,
            heading: isHeadingNode(node) ? 1 : 0,
            prose: isProseNode(node) ? 1 : 0,
        };

        for (const child of node.children) {
            const childSignal = visit(child, depth + 1, node);
            self.size += childSignal.size;
            self.interactive += childSignal.interactive;
            self.field += childSignal.field;
            self.listItem += childSignal.listItem;
            self.row += childSignal.row;
            self.heading += childSignal.heading;
            self.prose += childSignal.prose;
        }

        signalById.set(node.id, self);
        exitById.set(node.id, clock);
        clock += 1;
        return self;
    };

    visit(root, 0, null);
    return {
        nodeById,
        parentById,
        depthById,
        signalById,
        enterById,
        exitById,
    };
};

const scoreRegionFeatures = (
    region: RegionDetection,
    node: UnifiedNode,
    signal: CandidateSignal,
    depth: number,
): CandidateFeatures => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    const explicitness = calcExplicitness(region.evidence.explicitRole, region.evidence.explicitTag, region.evidence.explicitClass);
    const structuralDensity = safeRatio(signal.row + signal.listItem + signal.field, signal.size);
    const interactiveDensity = safeRatio(signal.interactive, signal.size);
    const headingDensity = safeRatio(signal.heading, signal.size);
    const proseDensity = safeRatio(signal.prose, signal.size);

    const semanticScore = clamp01(
        explicitness * 0.55 +
            (matchesKindSemantic(region.kind, role, tag) ? 0.35 : 0) +
            (region.name ? 0.16 : 0),
    );

    let dominantStructureScore = 0;
    if (region.kind === 'table') {
        dominantStructureScore = clamp01(safeRatio(signal.row, signal.size) * 4 + (signal.row >= 2 ? 0.25 : 0));
    } else if (region.kind === 'list') {
        dominantStructureScore = clamp01(safeRatio(signal.listItem, signal.size) * 3.5 + (signal.listItem >= 4 ? 0.2 : 0));
    } else if (region.kind === 'form') {
        dominantStructureScore = clamp01(safeRatio(signal.field, signal.size) * 4 + (signal.field >= 2 ? 0.25 : 0));
    } else if (region.kind === 'panel') {
        dominantStructureScore = clamp01(structuralDensity * 1.4 + interactiveDensity * 0.8);
    } else {
        dominantStructureScore = clamp01(interactiveDensity * 2.2 + explicitness * 0.2);
    }

    const interactionScore = clamp01(interactiveDensity * 2.5 + safeRatio(signal.field, signal.size) * 1.1);

    const boundaryScore = clamp01(
        0.65 +
            (isDocumentContainer(role, tag) ? -0.3 : 0) +
            (signal.size > 180 ? -0.22 : signal.size > 110 ? -0.12 : 0) +
            (region.name ? 0.12 : 0),
    );

    const minimalityScore = clamp01(
        0.35 +
            depth / 16 -
            (signal.size > 160 ? 0.3 : signal.size > 90 ? 0.18 : 0) -
            (isDocumentContainer(role, tag) ? 0.15 : 0),
    );

    const prosePenalty = clamp01(
        headingDensity * (region.kind === 'panel' ? 2.2 : 1.8) +
            proseDensity * (region.kind === 'list' || region.kind === 'panel' ? 1.2 : 0.7),
    );

    const docNoisePenalty = clamp01(
        (isDocumentContainer(role, tag) ? 0.5 : 0) +
            (region.kind === 'panel' ? 0.15 : 0) +
            (region.kind === 'list' && !region.evidence.explicitRole && !region.evidence.explicitTag ? 0.2 : 0) +
            (headingDensity > 0.1 && structuralDensity < 0.08 ? 0.35 : 0),
    );

    const confidence = clamp01(
        semanticScore * 0.5 +
            dominantStructureScore * 0.35 +
            (region.name ? 0.12 : 0) +
            (region.kind === 'list' && !region.evidence.explicitRole && !region.evidence.explicitTag
                ? Math.min(0.2, safeRatio(signal.listItem, signal.size) * 0.5)
                : 0.1),
    );

    return {
        semanticScore,
        dominantStructureScore,
        interactionScore,
        boundaryScore,
        minimalityScore,
        prosePenalty,
        docNoisePenalty,
        redundancyPenalty: 0,
        nestedSameTypePenalty: 0,
        confidence,
    };
};

const scoreGroupFeatures = (
    group: GroupDetection,
    node: UnifiedNode,
    signal: CandidateSignal,
    depth: number,
): CandidateFeatures => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    const explicitness = calcExplicitness(group.evidence.explicitRole, group.evidence.explicitTag, group.evidence.explicitClass);

    const itemCount = group.signal.itemCount;
    const slotCount = group.signal.slotCount;
    const stableRate = group.signal.stableRate;
    const keyCoverage = group.signal.keyCoverage;
    const keyUniqueness = group.signal.keyUniqueness;

    const semanticScore = clamp01(
        explicitness * 0.45 +
            (group.kind === 'table' && group.signal.hasTableSemantic ? 0.4 : 0) +
            (group.kind === 'list' && group.signal.hasListSemantic ? 0.32 : 0) +
            (group.name ? 0.14 : 0),
    );

    let dominantStructureScore = 0;
    if (group.kind === 'table') {
        dominantStructureScore = clamp01(stableRate * 0.48 + Math.min(1, slotCount / 4) * 0.26 + Math.min(1, itemCount / 8) * 0.26);
    } else if (group.kind === 'kv') {
        dominantStructureScore = clamp01((slotCount === 2 ? 0.45 : 0) + keyCoverage * 0.28 + keyUniqueness * 0.27);
    } else {
        dominantStructureScore = clamp01(stableRate * 0.44 + keyCoverage * 0.26 + Math.min(1, itemCount / 8) * 0.3);
    }

    const interactionScore = clamp01(
        (group.signal.interactiveItemRate || 0) * 0.65 +
            safeRatio(signal.interactive, signal.size) * 0.25 +
            safeRatio(signal.field, signal.size) * 0.1,
    );

    const boundaryScore = clamp01(
        0.65 -
            group.signal.wrapperDepth * 0.18 -
            (isDocumentContainer(role, tag) ? 0.18 : 0) -
            (signal.size > 160 ? 0.12 : 0) +
            (group.name ? 0.1 : 0),
    );

    const minimalityScore = clamp01(
        0.34 +
            depth / 16 -
            group.signal.wrapperDepth * 0.16 -
            (signal.size > 170 ? 0.2 : signal.size > 110 ? 0.1 : 0),
    );

    const prosePenalty = clamp01(
        group.signal.headingRate * (group.kind === 'list' ? 2.1 : 1.4) +
            safeRatio(signal.prose, signal.size) * 0.8,
    );

    const docNoisePenalty = clamp01(
        (isDocumentContainer(role, tag) ? 0.45 : 0) +
            (group.kind === 'list' && !group.evidence.explicitListSemantic && !group.signal.hasListSemantic ? 0.28 : 0) +
            (group.kind === 'table' && !group.signal.hasTableSemantic && stableRate < 0.55 ? 0.2 : 0),
    );

    let confidence = clamp01(
        semanticScore * 0.34 +
            dominantStructureScore * 0.3 +
            keyCoverage * 0.2 +
            keyUniqueness * 0.16,
    );

    if (group.kind === 'list' && !group.evidence.explicitListSemantic && !group.signal.hasListSemantic) {
        confidence = clamp01(
            confidence * (0.55 + stableRate * 0.35) * (0.65 + Math.min(0.35, (group.signal.interactiveItemRate || 0) * 0.7)),
        );
    }

    return {
        semanticScore,
        dominantStructureScore,
        interactionScore,
        boundaryScore,
        minimalityScore,
        prosePenalty,
        docNoisePenalty,
        redundancyPenalty: 0,
        nestedSameTypePenalty: 0,
        confidence,
    };
};

const buildRegionCandidateEvidence = (
    region: RegionDetection,
    node: UnifiedNode,
    features: CandidateFeatures,
): CandidateEvidence => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    const explicitness = calcExplicitness(region.evidence.explicitRole, region.evidence.explicitTag, region.evidence.explicitClass);
    return {
        explicitRole: region.evidence.explicitRole,
        explicitTag: region.evidence.explicitTag,
        explicitClass: region.evidence.explicitClass,
        hasName: Boolean(region.name),
        shellLike: region.evidence.shellLike,
        codeLike: region.evidence.codeLike,
        headingDominant: region.evidence.headingDominant,
        explicitness: clamp01(
            explicitness +
                (matchesKindSemantic(region.kind, role, tag) ? 0.2 : 0) +
                (features.confidence > 0.6 ? 0.1 : 0),
        ),
    };
};

const buildGroupCandidateEvidence = (
    group: GroupDetection,
    node: UnifiedNode,
    features: CandidateFeatures,
): CandidateEvidence => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    const explicitness = calcExplicitness(group.evidence.explicitRole, group.evidence.explicitTag, group.evidence.explicitClass);
    return {
        explicitRole: group.evidence.explicitRole,
        explicitTag: group.evidence.explicitTag,
        explicitClass: group.evidence.explicitClass,
        hasName: Boolean(group.name),
        shellLike: group.evidence.shellLike,
        codeLike: group.evidence.codeLike,
        headingDominant: group.signal.headingRate >= 0.62,
        explicitness: clamp01(
            explicitness +
                (matchesKindSemantic(group.kind, role, tag) ? 0.18 : 0) +
                (features.confidence > 0.6 ? 0.12 : 0),
        ),
    };
};

const resolveConflict = (
    candidate: StructureCandidate,
    existing: StructureCandidate,
    context: TreeContext,
): ConflictDecision => {
    if (candidate.nodeId === existing.nodeId) {
        if (candidate.kind === 'panel' && existing.kind !== 'panel') {
            return { dropCandidate: true, note: 'same-node-panel-weaker' };
        }
        if (existing.kind === 'panel' && candidate.kind !== 'panel') {
            return { dropExisting: true, note: 'same-node-non-panel-preferred' };
        }
        if (candidate.kind === 'table' && candidate.source !== existing.source) {
            const region = candidate.source === 'region' ? candidate : existing.source === 'region' ? existing : undefined;
            const group = candidate.source === 'group' ? candidate : existing.source === 'group' ? existing : undefined;
            if (region && group && region.evidence.explicitness >= group.evidence.explicitness - 0.05) {
                if (candidate === region) {return { dropExisting: true, note: 'same-node-table-region-over-group' };}
                return { dropCandidate: true, note: 'same-node-table-group-under-region' };
            }
        }
        if (candidate.source === 'group' && existing.source === 'region' && candidate.kind === existing.kind) {
            if (candidate.score >= existing.score - 0.15) {return { dropExisting: true, note: 'same-node-group-over-region-score' };}
        }
        if (existing.source === 'group' && candidate.source === 'region' && candidate.kind === existing.kind) {
            if (existing.score >= candidate.score - 0.15) {return { dropCandidate: true, note: 'same-node-region-under-group-score' };}
        }
        return candidate.score >= existing.score
            ? { dropExisting: true, note: 'same-node-higher-score-kept' }
            : { dropCandidate: true, note: 'same-node-lower-score-dropped' };
    }

    const candidateAncestor = isAncestorNode(candidate.nodeId, existing.nodeId, context);
    const existingAncestor = isAncestorNode(existing.nodeId, candidate.nodeId, context);

    if (!candidateAncestor && !existingAncestor) {
        if (candidate.source === 'group' && existing.source === 'group') {
            const overlap = groupItemOverlap(candidate.group, existing.group);
            if (overlap >= 0.72) {
                return pickByKindPriority(candidate, existing);
            }
        }
        return {};
    }

    const outer = candidateAncestor ? candidate : existing;
    const inner = candidateAncestor ? existing : candidate;

    if (outer.kind === inner.kind) {
        if (outer.kind === 'table' && isTableSectionCandidate(inner, context) && !isTableSectionCandidate(outer, context)) {
            if (outer === candidate) {return { dropExisting: true, note: 'table-section-under-table' };}
            return { dropCandidate: true, note: 'table-section-preferred-over-ancestor-section' };
        }
        if (SAME_KIND_NEST_DROP.has(outer.kind)) {
            if (outer === candidate) {return { dropCandidate: true, note: 'same-kind-nested-drop-ancestor' };}
            return { dropExisting: true, note: 'same-kind-nested-drop-existing-ancestor' };
        }
        if (outer === candidate) {
            return {
                candidateRedundancyPenalty: 0.2,
                candidateNestedPenalty: 0.22,
                dropCandidate: candidate.score <= inner.score + 0.1,
                note: 'same-kind-nested-penalty',
            };
        }
        return { dropExisting: true, note: 'same-kind-nested-descendant-preferred' };
    }

    if (outer.kind === 'panel' && inner.kind !== 'panel') {
        if (outer === candidate) {return { dropCandidate: true, note: 'panel-vs-structured-drop-panel' };}
        return { dropExisting: true, note: 'panel-vs-structured-drop-existing-panel' };
    }

    if (outer.kind === 'list' && (inner.kind === 'table' || inner.kind === 'kv')) {
        if (outer === candidate) {return { dropCandidate: true, note: 'list-vs-table-drop-list' };}
        return { dropExisting: true, note: 'list-vs-table-drop-existing-list' };
    }

    if (outer.kind === 'table' && inner.kind === 'list' && outer.features.docNoisePenalty >= 0.4) {
        if (outer === candidate) {return { dropCandidate: true, note: 'noisy-table-vs-list-drop-table' };}
        return { dropExisting: true, note: 'noisy-table-vs-list-drop-existing-table' };
    }

    if (outer.source === 'group' && inner.source === 'group' && isDocumentCandidate(outer) && inner.features.dominantStructureScore >= 0.35) {
        if (outer === candidate) {return { dropCandidate: true, note: 'group-doc-vs-structured-drop-doc-group' };}
        return { dropExisting: true, note: 'group-doc-vs-structured-drop-existing-doc-group' };
    }

    if (outer.kind === 'table' && inner.kind === 'table') {
        if (outer === candidate) {return { dropCandidate: true, note: 'table-vs-table-descendant-preferred' };}
        return { dropExisting: true, note: 'table-vs-table-drop-existing-ancestor' };
    }

    if (isDocumentCandidate(outer) && inner.score >= outer.score - 0.4) {
        if (outer === candidate) {return { dropCandidate: true, note: 'doc-noise-under-inner' };}
        return { dropExisting: true, note: 'doc-noise-existing-under-candidate' };
    }

    if (outer === candidate) {
        return { candidateRedundancyPenalty: 0.14, note: 'ancestor-redundancy-penalty' };
    }
    return {};
};

const pickByKindPriority = (candidate: StructureCandidate, existing: StructureCandidate): ConflictDecision => {
    const candidatePriority = kindPriority(candidate.kind);
    const existingPriority = kindPriority(existing.kind);
    if (candidatePriority > existingPriority) {return { dropExisting: true };}
    if (candidatePriority < existingPriority) {return { dropCandidate: true };}
    if (candidate.score >= existing.score) {return { dropExisting: true };}
    return { dropCandidate: true };
};

const capCandidates = (
    candidates: StructureCandidate[],
    context: TreeContext,
): { kept: StructureCandidate[]; dropped: StructureCandidate[] } => {
    const limits = resolveAdaptiveLimits(candidates, context);
    const used: Record<EntityKind, number> = {
        panel: 0,
        form: 0,
        table: 0,
        list: 0,
        dialog: 0,
        toolbar: 0,
        kv: 0,
    };
    const kept: StructureCandidate[] = [];
    const dropped: StructureCandidate[] = [];
    const usedTableFamily = new Map<string, number>();

    for (const candidate of candidates) {
        if (candidate.kind === 'table') {
            const familyKey = resolveTableFamilyKey(candidate, context);
            const usedCount = usedTableFamily.get(familyKey) || 0;
            if (usedCount >= TABLE_PER_FAMILY_LIMIT) {
                dropped.push(candidate);
                continue;
            }
            usedTableFamily.set(familyKey, usedCount + 1);
        }

        const limit = limits[candidate.kind] || 8;
        if (used[candidate.kind] >= limit) {
            dropped.push(candidate);
            continue;
        }
        used[candidate.kind] += 1;
        kept.push(candidate);
    }

    return { kept, dropped };
};

const resolveAdaptiveLimits = (
    candidates: StructureCandidate[],
    context: TreeContext,
): Record<EntityKind, number> => {
    const limits: Record<EntityKind, number> = {
        ...BASE_LIMIT_BY_KIND,
    };

    const strongTableCandidates = candidates.filter((candidate) => {
        if (candidate.kind !== 'table') {return false;}
        if (candidate.features.docNoisePenalty >= 0.68) {return false;}
        if (candidate.features.dominantStructureScore < 0.28) {return false;}
        if (candidate.features.confidence < 0.42) {return false;}
        if (candidate.evidence.explicitRole || candidate.evidence.explicitTag) {return true;}
        if ((candidate.signal.row || 0) >= 2) {return true;}
        if ((candidate.signal.itemCount || 0) >= 3 && (candidate.signal.slotCount || 0) >= 2) {return true;}
        return false;
    });

    if (strongTableCandidates.length > limits.table) {
        const strongFamilies = new Set(
            strongTableCandidates.map((candidate) => resolveTableFamilyKey(candidate, context)),
        ).size;
        const familyDrivenLimit = Math.max(
            limits.table,
            strongFamilies + TABLE_LIMIT_BUFFER,
            Math.ceil(strongFamilies * TABLE_LIMIT_MULTIPLIER),
        );
        limits.table = clampRange(familyDrivenLimit, limits.table, MAX_TABLE_LIMIT);
    }

    return limits;
};

const resolveTableFamilyKey = (candidate: StructureCandidate, context: TreeContext): string => {
    let cursor = context.nodeById.get(candidate.nodeId) || null;
    let wrapperAnchor: string | undefined;
    let semanticAnchor: string | undefined;

    while (cursor) {
        const role = normalizeLower(cursor.role);
        const tag = normalizeLower(getNodeAttr(cursor, 'tag') || getNodeAttr(cursor, 'tagName'));
        const cls = normalizeLower(getNodeAttr(cursor, 'class'));
        if (!wrapperAnchor && TABLE_WRAPPER_CLASS_HINTS.some((hint) => cls.includes(hint))) {
            wrapperAnchor = cursor.id;
        }
        if (!semanticAnchor && (role === 'table' || role === 'grid' || role === 'treegrid' || tag === 'table')) {
            semanticAnchor = cursor.id;
        }
        cursor = context.parentById.get(cursor.id) || null;
    }

    return wrapperAnchor || semanticAnchor || candidate.nodeId;
};

const scoreCandidate = (features: CandidateFeatures): number => {
    return (
        features.semanticScore * 1.75 +
        features.dominantStructureScore * 2.15 +
        features.interactionScore * 1.0 +
        features.boundaryScore * 1.2 +
        features.minimalityScore * 1.35 +
        features.confidence * 1.55 -
        features.prosePenalty * 1.5 -
        features.docNoisePenalty * 1.65 -
        features.redundancyPenalty * 1.3 -
        features.nestedSameTypePenalty * 1.45
    );
};

const applyPenalty = (
    candidate: StructureCandidate,
    redundancyPenalty: number,
    nestedPenalty: number,
) => {
    candidate.features.redundancyPenalty = clamp01(candidate.features.redundancyPenalty + redundancyPenalty);
    candidate.features.nestedSameTypePenalty = clamp01(candidate.features.nestedSameTypePenalty + nestedPenalty);
    candidate.score = scoreCandidate(candidate.features);
};

const compareCandidatePriority = (left: StructureCandidate, right: StructureCandidate): number => {
    if (right.score !== left.score) {return right.score - left.score;}
    if (right.features.confidence !== left.features.confidence) {
        return right.features.confidence - left.features.confidence;
    }
    if (right.features.minimalityScore !== left.features.minimalityScore) {
        return right.features.minimalityScore - left.features.minimalityScore;
    }
    return right.depth - left.depth;
};

const passesScoreThreshold = (candidate: StructureCandidate): boolean => {
    const threshold = MIN_SCORE_BY_KIND[candidate.kind] || 1.3;
    if (candidate.score < threshold) {return false;}
    if (candidate.kind === 'list') {
        if (candidate.features.confidence < 0.38) {return false;}
        if (candidate.source === 'region' && !candidate.evidence.explicitRole && !candidate.evidence.explicitTag) {
            if ((candidate.signal.listItem || 0) < 5) {return false;}
        }
    }
    if (candidate.kind === 'panel') {
        if (!candidate.evidence.hasName && candidate.features.confidence < 0.5) {return false;}
        if (candidate.features.docNoisePenalty >= 0.65 && candidate.features.dominantStructureScore < 0.35) {return false;}
    }
    return true;
};

const isDocumentCandidate = (candidate: StructureCandidate): boolean => {
    return candidate.features.docNoisePenalty >= 0.55;
};

const isTableSectionCandidate = (candidate: StructureCandidate, context: TreeContext): boolean => {
    if (candidate.kind !== 'table') {return false;}
    const node = context.nodeById.get(candidate.nodeId);
    if (!node) {return false;}
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    if (role === 'rowgroup') {return true;}
    return tag === 'tbody' || tag === 'thead' || tag === 'tfoot';
};

const isAncestorNode = (ancestorId: string, nodeId: string, context: TreeContext): boolean => {
    const ancestorEnter = context.enterById.get(ancestorId);
    const ancestorExit = context.exitById.get(ancestorId);
    const nodeEnter = context.enterById.get(nodeId);
    const nodeExit = context.exitById.get(nodeId);
    if (ancestorEnter === undefined || ancestorExit === undefined || nodeEnter === undefined || nodeExit === undefined) {
        return false;
    }
    return ancestorEnter < nodeEnter && ancestorExit > nodeExit;
};

const groupItemOverlap = (
    left: GroupDetection | undefined,
    right: GroupDetection | undefined,
): number => {
    if (!left || !right) {return 0;}
    if (left.itemIds.length === 0 || right.itemIds.length === 0) {return 0;}
    const rightSet = new Set(right.itemIds);
    let intersect = 0;
    for (const itemId of left.itemIds) {
        if (rightSet.has(itemId)) {intersect += 1;}
    }
    return intersect / Math.min(left.itemIds.length, right.itemIds.length);
};

const kindPriority = (kind: EntityKind): number => {
    return KIND_PRIORITY[kind] || 0;
};

const matchesKindSemantic = (kind: EntityKind, role: string, tag: string): boolean => {
    if (kind === 'table') {return role === 'table' || role === 'grid' || tag === 'table';}
    if (kind === 'list') {return role === 'list' || role === 'listbox' || tag === 'ul' || tag === 'ol' || tag === 'menu';}
    if (kind === 'form') {return role === 'form' || tag === 'form';}
    if (kind === 'dialog') {return role === 'dialog' || role === 'alertdialog';}
    if (kind === 'toolbar') {return role === 'toolbar';}
    if (kind === 'panel') {return PANEL_ROLES.has(role) || PANEL_TAGS.has(tag);}
    if (kind === 'kv') {return role === 'table' || tag === 'dl' || tag === 'table';}
    return false;
};

const calcExplicitness = (explicitRole: boolean, explicitTag: boolean, explicitClass: boolean): number => {
    return clamp01((explicitRole ? 0.45 : 0) + (explicitTag ? 0.35 : 0) + (explicitClass ? 0.2 : 0));
};

const clamp01 = (value: number): number => {
    if (value <= 0) {return 0;}
    if (value >= 1) {return 1;}
    return value;
};

const safeRatio = (numerator: number, denominator: number): number => {
    if (!denominator || denominator <= 0) {return 0;}
    return numerator / denominator;
};

const normalizeLower = (value: string | undefined): string => (value || '').trim().toLowerCase();

const isDocumentContainer = (role: string, tag: string): boolean => {
    if (DOC_CONTAINER_ROLES.has(role)) {return true;}
    if (DOC_CONTAINER_TAGS.has(tag)) {return true;}
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
    if (PROSE_ROLES.has(role) || PROSE_TAGS.has(tag)) {return true;}
    const text = normalizeText(node.name || getNodeContent(node));
    if (!text) {return false;}
    return text.length >= 56 && text.split(' ').length >= 10;
};

const isFieldNode = (node: UnifiedNode): boolean => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    return FIELD_ROLES.has(role) || FIELD_TAGS.has(tag);
};

const isInteractiveNode = (node: UnifiedNode): boolean => {
    const role = normalizeLower(node.role);
    const tag = normalizeLower(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    if (INTERACTIVE_ROLES.has(role) || INTERACTIVE_TAGS.has(tag)) {return true;}
    if (node.target) {return true;}
    if (getNodeAttr(node, 'onclick') || getNodeAttr(node, 'href') || getNodeAttr(node, 'tabindex')) {return true;}
    return false;
};

const SAME_KIND_NEST_DROP = new Set<EntityKind>(['table', 'list', 'panel']);
const KIND_PRIORITY: Record<EntityKind, number> = {
    table: 6,
    kv: 5,
    list: 4,
    form: 4,
    dialog: 4,
    toolbar: 3,
    panel: 2,
};
const MIN_SCORE_BY_KIND: Record<EntityKind, number> = {
    table: 1.45,
    kv: 1.45,
    list: 1.75,
    form: 1.3,
    dialog: 1.15,
    toolbar: 1.1,
    panel: 1.9,
};
const clampRange = (value: number, min: number, max: number): number => {
    if (value <= min) {return min;}
    if (value >= max) {return max;}
    return value;
};

const BASE_LIMIT_BY_KIND: Record<EntityKind, number> = {
    panel: 10,
    form: 10,
    table: 10,
    list: 8,
    dialog: 6,
    toolbar: 4,
    kv: 8,
};
const MAX_TABLE_LIMIT = 96;
const TABLE_PER_FAMILY_LIMIT = 1;
const TABLE_WRAPPER_CLASS_HINTS = ['table-wrapper', 'datatable', 'data-table', 'grid-wrapper'];
const TABLE_LIMIT_BUFFER = 12;
const TABLE_LIMIT_MULTIPLIER = 1.5;

const PANEL_ROLES = new Set(['region', 'complementary', 'contentinfo']);
const PANEL_TAGS = new Set(['section', 'article', 'aside', 'nav']);
const DOC_CONTAINER_ROLES = new Set([
    'main',
    'article',
    'section',
    'navigation',
    'complementary',
    'contentinfo',
    'banner',
    'root',
    'document',
    'webarea',
]);
const DOC_CONTAINER_TAGS = new Set(['main', 'article', 'section', 'nav', 'aside', 'body']);
const INTERACTIVE_ROLES = new Set([
    'button',
    'link',
    'menuitem',
    'tab',
    'textbox',
    'input',
    'textarea',
    'select',
    'checkbox',
    'radio',
    'combobox',
]);
const INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'textarea', 'select']);
const FIELD_ROLES = new Set(['textbox', 'input', 'textarea', 'select', 'combobox', 'checkbox', 'radio']);
const FIELD_TAGS = new Set(['input', 'textarea', 'select']);
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const PROSE_ROLES = new Set(['paragraph', 'article', 'section']);
const PROSE_TAGS = new Set(['p', 'article', 'section']);
