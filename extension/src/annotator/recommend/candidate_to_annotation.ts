import type {
    CanvasAnnotationDraft,
    CanvasAnnotationType,
    CanvasEntityDraft,
    EntityRuleExpect,
    PersistentTargetDraft,
    PickCandidate,
} from '../types.js';
import {recommendAnnotationTypes, type RecommendedType} from './recommend_types.js';

const DEFAULT_BUSINESS_KEY_PREFIX = 'ann';

const slugify = (input: string): string =>
    input
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 24);

const ensureBusinessKey = (
    base: string,
    existing: Set<string>,
): string => {
    const slug = slugify(base) || DEFAULT_BUSINESS_KEY_PREFIX;
    if (!existing.has(slug)) {
        existing.add(slug);
        return slug;
    }
    let suffix = 2;
    while (existing.has(`${slug}_${suffix}`)) {
        suffix += 1;
    }
    const next = `${slug}_${suffix}`;
    existing.add(next);
    return next;
};

const recommendToAnnotationType = (
    recommended: RecommendedType,
): CanvasAnnotationType | null => {
    switch (recommended) {
        case 'field': return 'field';
        case 'action': return 'action';
        case 'pagination': return 'pagination';
        case 'column': return 'field';
        case 'row_action': return 'action';
        default: return null;
    }
};

const targetFromCandidate = (
    candidate: PickCandidate,
): PersistentTargetDraft => {
    if (candidate.proposedTargets && candidate.proposedTargets.length > 0) {
        return {...candidate.proposedTargets[0]};
    }
    const target: PersistentTargetDraft = {};
    if (candidate.role) {target.roleEquals = candidate.role;}
    return target;
};

const expectFromCandidate = (
    candidate: PickCandidate,
    recommended: RecommendedType,
): EntityRuleExpect => {
    if (recommended === 'row_action') {return 'one_or_more';}
    return candidate.expect ?? 'unique';
};

export type CandidateAnnotationPlan = {
    annotation: CanvasAnnotationDraft;
    recommendedTypes: RecommendedType[];
    expect: EntityRuleExpect;
};

export const planAnnotationFromCandidate = (
    candidate: PickCandidate,
    entity: CanvasEntityDraft,
    recommendedType?: RecommendedType,
): CandidateAnnotationPlan => {
    const recommended = recommendAnnotationTypes(candidate, entity.kind);
    const chosen = recommendedType && recommended.includes(recommendedType)
        ? recommendedType
        : recommended[0];
    const type = recommendToAnnotationType(chosen) ?? 'field';
    const target = targetFromCandidate(candidate);
    const expect = expectFromCandidate(candidate, chosen);
    const existingKeys = new Set<string>();
    for (const existing of entity.annotations) {
        existingKeys.add(existing.businessKey);
    }
    const labelBase = candidate.text || candidate.actionIntent || candidate.fieldKey || chosen;
    const businessKey = ensureBusinessKey(labelBase, existingKeys);
    const annotation: CanvasAnnotationDraft = {
        id: `ann_${Math.random().toString(36).slice(2, 10)}`,
        type,
        name: candidate.text,
        businessKey,
        target,
        expect,
        origin: 'manual',
        disposition: 'active',
    };
    return {annotation, recommendedTypes: recommended, expect};
};
