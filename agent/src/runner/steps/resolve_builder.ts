import type { SnapshotResult } from './executors/snapshot/core/types';
import { normalizeText } from './executors/snapshot/core/runtime_store';
import type { StepResolve } from './types';

type ResolveBuilderCandidate = {
    nodeId?: string;
    selector?: string;
    role?: string;
    name?: string;
    text?: string;
    confidence: number;
    reason: string[];
};

const normalize = (value: string | undefined): string => normalizeText(value)?.toLowerCase() || '';

export const buildResolveFromSnapshotCandidate = (input: {
    snapshot?: SnapshotResult;
    candidate: ResolveBuilderCandidate;
    rawSelector?: string;
    rawLocatorCandidates?: NonNullable<NonNullable<StepResolve['hint']>['raw']>['locatorCandidates'];
    source: 'capture_resolve' | 'record_enrichment';
    warnings?: string[];
}): StepResolve => {
    const { snapshot, candidate, rawSelector, rawLocatorCandidates, source } = input;
    const warnings = input.warnings || [];
    const isLowConfidenceRawOnly = warnings.includes('LOW_CONFIDENCE_RAW_ONLY');
    const preferRawSelector = source === 'record_enrichment' && Boolean(rawSelector);
    const nodeId = candidate.nodeId || '';
    const locator = nodeId ? snapshot?.locatorIndex[nodeId] : undefined;
    const attrs = nodeId ? snapshot?.attrIndex[nodeId] : undefined;
    const bbox = nodeId ? snapshot?.bboxIndex[nodeId] : undefined;
    const directQuery = locator?.direct?.kind === 'css' ? locator.direct.query : undefined;
    const directFallback = locator?.direct?.fallback;
    const directSelector = preferRawSelector ? rawSelector : (directQuery || candidate.selector || rawSelector);
    const mergedCandidates = [
        ...(rawLocatorCandidates || []),
        ...(directSelector ? [{ kind: 'css', selector: directSelector, note: `${source} preferred selector` }] : []),
        ...(attrs?.['data-testid'] ? [{ kind: 'testid', testId: attrs['data-testid'], note: `${source} data-testid` }] : []),
        ...((candidate.role || candidate.name)
            ? [{ kind: 'role', role: candidate.role, name: candidate.name, exact: true, note: `${source} role locator` }]
            : []),
        ...(candidate.text ? [{ kind: 'text', text: candidate.text, exact: true, note: `${source} text locator` }] : []),
    ] as NonNullable<NonNullable<StepResolve['hint']>['raw']>['locatorCandidates'];

    return {
        hint: {
            target: {
                nodeId: isLowConfidenceRawOnly ? undefined : candidate.nodeId,
                primaryDomId: isLowConfidenceRawOnly ? undefined : locator?.origin?.primaryDomId,
                sourceDomIds: isLowConfidenceRawOnly ? undefined : locator?.origin?.sourceDomIds,
                role: candidate.role,
                tag: attrs?.tag || attrs?.tagName,
                name: candidate.name,
                text: candidate.text,
                attrs: isLowConfidenceRawOnly ? undefined : (attrs && Object.keys(attrs).length > 0 ? attrs : undefined),
                bbox: isLowConfidenceRawOnly ? undefined : bbox,
            },
            locator: {
                direct: directSelector
                    ? {
                          kind: 'css',
                          query: directSelector,
                          fallback: directFallback,
                      }
                    : undefined,
                scope: locator?.scope ? { id: locator.scope.id, kind: locator.scope.kind } : undefined,
                origin: !isLowConfidenceRawOnly && locator?.origin
                    ? {
                          primaryDomId: locator.origin.primaryDomId,
                          sourceDomIds: locator.origin.sourceDomIds,
                      }
                    : undefined,
            },
            raw: {
                selector: rawSelector || directSelector,
                locatorCandidates: mergedCandidates.length > 0 ? dedupeLocatorCandidates(mergedCandidates) : undefined,
                targetHint: normalizeText([candidate.role, candidate.name, candidate.text].filter(Boolean).join(' > ')),
            },
            capture: {
                source,
                confidence: candidate.confidence,
                reason: [...candidate.reason],
                warnings: [...warnings],
            },
        },
        policy: {
            preferDirect: true,
            requireVisible: true,
            allowFuzzy: candidate.confidence < 0.8,
            allowIndexDrift: true,
        },
    };
};

const dedupeLocatorCandidates = (
    candidates: NonNullable<NonNullable<StepResolve['hint']>['raw']>['locatorCandidates'],
): NonNullable<NonNullable<StepResolve['hint']>['raw']>['locatorCandidates'] => {
    const seen = new Set<string>();
    const out: NonNullable<NonNullable<StepResolve['hint']>['raw']>['locatorCandidates'] = [];
    for (const item of candidates) {
        const key = [
            item.kind,
            normalize(item.selector),
            normalize(item.testId),
            normalize(item.role),
            normalize(item.name),
            normalize(item.text),
            item.exact ? '1' : '0',
        ].join('|');
        if (seen.has(key)) {continue;}
        seen.add(key);
        out.push(item);
    }
    return out;
};
