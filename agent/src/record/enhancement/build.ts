import type { Page } from 'playwright';
import type { RecorderEvent } from '../capture/recorder';
import { generateSemanticSnapshot } from '../../runner/steps/executors/snapshot/pipeline/snapshot';
import { getNodeSemanticHints } from '../../runner/steps/executors/snapshot/core/runtime_store';
import type { SnapshotResult, UnifiedNode } from '../../runner/steps/executors/snapshot/core/types';
import type { ResolveHint } from '../../runner/steps/types';
import type { RecordedEntityBinding, RecordedStepEnhancement, RecordedTargetFingerprint } from '../types';
import { buildResolveFromSnapshotCandidate } from '../../runner/steps/resolve_builder';
import { normalizeResolveHint } from '../../runner/steps/resolve_utils';

export type RecordSnapshotCacheEntry = {
    snapshot: SnapshotResult;
    capturedAt: number;
    pageUrl: string;
};

const SNAPSHOT_CACHE_TTL_MS = 1500;

export const enrichRecordedStepWithSnapshot = async (input: {
    event: RecorderEvent;
    page?: Page;
    snapshotCache: Map<string, RecordSnapshotCacheEntry>;
    cacheKey: string;
}): Promise<RecordedStepEnhancement> => {
    const { event, page, snapshotCache, cacheKey } = input;
    if (isPageLevelEvent(event)) {
        const snapshot = await resolveSnapshotForEvent({ event, page, snapshotCache, cacheKey });
        if (!snapshot) {
            return withRawContext(event, buildLowConfidenceRawOnlyResolve(event));
        }
        return withRawContext(event, {
            version: 1,
            eventType: event.type,
            snapshot: {
                mode: snapshot.snapshotMeta?.mode,
                snapshotId: snapshot.snapshotMeta?.snapshotId,
                pageIdentity: snapshot.snapshotMeta?.pageIdentity,
                capturedAt: Date.now(),
            },
        });
    }
    if (requiresTargetSelector(event) && !event.selector) {
        return withRawContext(event, buildLowConfidenceRawOnlyResolve(event, {
            reason: ['missing_selector_for_target_event'],
            warnings: ['MISSING_SELECTOR_FOR_TARGET_EVENT', 'LOW_CONFIDENCE_RAW_ONLY'],
            confidence: 0.2,
        }));
    }
    const snapshot = await resolveSnapshotForEvent({ event, page, snapshotCache, cacheKey });
    if (!snapshot) {
        return withRawContext(event, buildLowConfidenceRawOnlyResolve(event));
    }

    const matchedNodeId = findSnapshotNodeIdByRawSelector(snapshot, event.selector);
    if (!matchedNodeId) {
        return withRawContext(event, {
            eventType: event.type,
            snapshot: {
                mode: snapshot.snapshotMeta?.mode,
                snapshotId: snapshot.snapshotMeta?.snapshotId,
                pageIdentity: snapshot.snapshotMeta?.pageIdentity,
                capturedAt: Date.now(),
            },
            ...buildLowConfidenceRawOnlyResolve(event),
        });
    }

    const node = snapshot.nodeIndex[matchedNodeId];
    const locator = snapshot.locatorIndex[matchedNodeId];
    const target = buildTargetFingerprint(snapshot, node, matchedNodeId, locator.origin);
    const entityBindings = buildEntityBindings(snapshot, matchedNodeId);
    const confidenceInfo = computeRecordConfidence(event, snapshot, matchedNodeId);
    const resolveDraft = buildResolveFromSnapshotCandidate({
        snapshot,
        candidate: {
            nodeId: target.nodeId,
            selector: event.selector,
            role: target.role,
            name: target.name,
            text: target.content,
            confidence: confidenceInfo.confidence,
            reason: confidenceInfo.reason,
        },
        rawSelector: event.selector,
        rawLocatorCandidates: event.locatorCandidates?.map((candidate) => ({ ...candidate })),
        source: 'record_enrichment',
        warnings: confidenceInfo.warnings,
    });
    const enhancement: RecordedStepEnhancement = {
        version: 1,
        eventType: event.type,
        snapshot: {
            mode: snapshot.snapshotMeta?.mode,
            snapshotId: snapshot.snapshotMeta?.snapshotId,
            pageIdentity: snapshot.snapshotMeta?.pageIdentity,
            capturedAt: Date.now(),
        },
        target,
        entityBindings,
        resolveHint: resolveDraft.hint,
        resolvePolicy: resolveDraft.policy,
    };

    return withRawContext(event, enhancement);
};

const resolveSnapshotForEvent = async (input: {
    event: RecorderEvent;
    page?: Page;
    snapshotCache: Map<string, RecordSnapshotCacheEntry>;
    cacheKey: string;
}): Promise<SnapshotResult | undefined> => {
    const { event, page, snapshotCache, cacheKey } = input;
    if (!shouldUseSnapshotForEvent(event)) {return undefined;}

    const now = Date.now();
    const cached = snapshotCache.get(cacheKey);
    if (cached && now - cached.capturedAt <= SNAPSHOT_CACHE_TTL_MS) {
        if (!page) {return cached.snapshot;}
        const pageUrl = safePageUrl(page);
        if (cached.pageUrl === pageUrl) {
            return cached.snapshot;
        }
    }

    if (!page) {return undefined;}

    const pageUrl = safePageUrl(page);

    try {
        const snapshot = await generateSemanticSnapshot(page, {
            captureRuntimeState: true,
            waitMode: 'interaction',
        });
        snapshotCache.set(cacheKey, {
            snapshot,
            capturedAt: now,
            pageUrl,
        });
        return snapshot;
    } catch {
        return undefined;
    }
};

const shouldUseSnapshotForEvent = (event: RecorderEvent): boolean => {
    if (isPageLevelEvent(event) || event.type === 'copy') {return false;}
    return true;
};

const isPageLevelEvent = (event: RecorderEvent): boolean => event.type === 'navigate' || event.type === 'scroll';

const requiresTargetSelector = (event: RecorderEvent): boolean => {
    return event.type === 'click'
        || event.type === 'input'
        || event.type === 'change'
        || event.type === 'date'
        || event.type === 'select'
        || event.type === 'check'
        || event.type === 'paste'
        || event.type === 'copy'
        || event.type === 'keydown';
};

const withRawContext = (event: RecorderEvent, enhancement?: RecordedStepEnhancement): RecordedStepEnhancement => {
    const existingHint = enhancement?.resolveHint;
    const mergedRaw: ResolveHint['raw'] = {
        ...(existingHint?.raw || {}),
        selector: event.selector,
        locatorCandidates: event.locatorCandidates?.map((candidate) => ({ ...candidate })),
        scopeHint: event.scopeHint || undefined,
        targetHint: event.targetHint,
    };
    const next: RecordedStepEnhancement = {
        ...(enhancement || { version: 1 }),
        version: 1,
        eventType: event.type,
        resolveHint: {
            ...(existingHint || {}),
            target: {
                ...(existingHint?.target || {}),
                tag: existingHint?.target?.tag || event.targetHint,
                role: existingHint?.target?.role || event.a11yHint?.role,
                attrs: existingHint?.target?.attrs || event.targetAttrs,
                state: existingHint?.target?.state || event.targetState,
            },
            raw: mergedRaw,
        },
        rawContext: {
            ...(enhancement?.rawContext || {}),
            pageUrl: event.pageUrl || event.url || undefined,
            recorderVersion: event.recorderVersion,
        },
    };
    next.resolveHint = normalizeResolveHint(next.resolveHint);
    return next;
};

const buildTargetFingerprint = (
    snapshot: SnapshotResult,
    node: UnifiedNode,
    nodeId: string,
    origin?: { primaryDomId: string; sourceDomIds?: string[] },
): RecordedTargetFingerprint => {
    const attrs = snapshot.attrIndex[nodeId] || {};
    const semanticHints = getNodeSemanticHints(node);
    return {
        nodeId,
        primaryDomId: origin?.primaryDomId,
        sourceDomIds: origin?.sourceDomIds,
        role: node.role,
        tag: attrs.tag || attrs.tagName,
        name: normalizeText(node.name),
        content: normalizeText(resolveNodeContent(snapshot, node)),
        attrs,
        bbox: snapshot.bboxIndex[nodeId],
        runtimeState: pickRuntimeState(attrs),
        semanticHints,
    };
};

const buildEntityBindings = (snapshot: SnapshotResult, nodeId: string): RecordedEntityBinding[] | undefined => {
    const refs = snapshot.entityIndex.byNodeId[nodeId] || [];
    if (!refs.length) {return undefined;}
    const bindings: RecordedEntityBinding[] = [];
    for (const ref of refs) {
        const entity = snapshot.entityIndex.entities[ref.entityId];
        bindings.push({
            entityId: ref.entityId,
            type: ref.type,
            role: ref.role,
            kind: entity.kind,
            itemId: ref.itemId,
            slotIndex: ref.slotIndex,
        });
    }
    return bindings;
};

const resolveNodeContent = (snapshot: SnapshotResult, node: UnifiedNode): string | undefined => {
    if (typeof node.content === 'string') {return node.content;}
    if (node.content && typeof node.content === 'object' && node.content.ref) {
        return snapshot.contentStore[node.content.ref];
    }
    return undefined;
};

const findSnapshotNodeIdByRawSelector = (snapshot: SnapshotResult, selector?: string): string | undefined => {
    const normalizedSelector = normalizeText(selector);
    if (!normalizedSelector) {return undefined;}
    const matched: string[] = [];
    for (const [nodeId, locator] of Object.entries(snapshot.locatorIndex || {})) {
        const directQuery = normalizeText(locator.direct?.query);
        if (directQuery && directQuery === normalizedSelector) {
            matched.push(nodeId);
        }
    }
    if (matched.length !== 1) {return undefined;}
    return matched[0];
};

const pickRuntimeState = (attrs: Record<string, string> | undefined): Record<string, string> | undefined => {
    if (!attrs) {return undefined;}
    const keys = [
        'value',
        'checked',
        'selected',
        'ariaChecked',
        'ariaSelected',
        'ariaExpanded',
        'ariaPressed',
        'disabled',
        'readonly',
        'invalid',
        'focused',
        'popupSelectedText',
        'ariaValueText',
        'ariaLabelledBy',
        'ariaDescribedBy',
        'contentEditableText',
    ];
    const state: Record<string, string> = {};
    for (const key of keys) {
        if (!attrs[key]) {continue;}
        state[key] = attrs[key];
    }
    if (!Object.keys(state).length) {return undefined;}
    return state;
};

const normalizeText = (value: string | undefined): string => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();

const safePageUrl = (page: Page): string => {
    try {
        return page.url();
    } catch {
        return '';
    }
};

const buildLowConfidenceRawOnlyResolve = (
    event: RecorderEvent,
    override?: { reason?: string[]; warnings?: string[]; confidence?: number },
): RecordedStepEnhancement => {
    const confidence = override?.confidence ?? 0.35;
    const reason = override?.reason ?? ['snapshot_unavailable'];
    const warnings = override?.warnings ?? ['SNAPSHOT_UNAVAILABLE', 'LOW_CONFIDENCE_RAW_ONLY'];
    return ({
        version: 1,
        eventType: event.type,
        resolveHint: {
            target: {
                role: event.a11yHint?.role,
                name: event.a11yHint?.name,
                text: event.a11yHint?.text,
                tag: event.targetHint,
                attrs: event.targetAttrs,
                state: event.targetState,
            },
            raw: {
                selector: event.selector,
                locatorCandidates: event.locatorCandidates?.map((candidate) => ({ ...candidate })),
                scopeHint: event.scopeHint || undefined,
                targetHint: event.targetHint,
            },
        },
        resolvePolicy: { requireVisible: true },
        confidence,
        confidenceReason: reason,
        warnings,
    } as unknown as RecordedStepEnhancement);
};

const computeRecordConfidence = (
    event: RecorderEvent,
    snapshot: SnapshotResult,
    matchedNodeId: string,
): { confidence: number; reason: string[]; warnings?: string[] } => {
    const reasons: string[] = [];
    const warnings: string[] = [];
    let confidence = 0.88;

    const locator = snapshot.locatorIndex[matchedNodeId];
    if (!locator?.direct?.query) {
        confidence -= 0.2;
        reasons.push('missing_direct_locator');
        warnings.push('MISSING_DIRECT_LOCATOR');
    }

    if (!event.a11yHint?.role && !event.a11yHint?.name && !event.a11yHint?.text) {
        confidence -= 0.1;
        reasons.push('missing_a11y_hint');
    }

    if (!event.locatorCandidates?.length) {
        confidence -= 0.08;
        reasons.push('missing_locator_candidates');
    }

    if (!event.selector) {
        confidence -= 0.2;
        reasons.push('missing_raw_selector');
        warnings.push('MISSING_RAW_SELECTOR');
    }

    if (confidence < 0.45) {
        warnings.push('LOW_CONFIDENCE');
    }

    return {
        confidence: Math.max(0.2, Math.min(0.98, Number(confidence.toFixed(2)))),
        reason: reasons.length ? reasons : ['snapshot_match'],
        warnings: warnings.length ? warnings : undefined,
    };
};
