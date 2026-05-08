import type { Page } from 'playwright';
import type { RecorderEvent } from './recorder';
import { generateSemanticSnapshot } from '../runner/steps/executors/snapshot/pipeline/snapshot';
import { getNodeSemanticHints } from '../runner/steps/executors/snapshot/core/runtime_store';
import type { SnapshotResult, UnifiedNode } from '../runner/steps/executors/snapshot/core/types';
import type { ResolveHint } from '../runner/steps/types';
import type { RecordedEntityBinding, RecordedStepEnhancement, RecordedTargetFingerprint } from './types';
import { buildResolveFromSnapshotCandidate } from '../runner/steps/resolve_builder';

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
            target: existingHint?.target,
            raw: mergedRaw,
        },
        rawContext: {
            ...(enhancement?.rawContext || {}),
            pageUrl: event.pageUrl || event.url || undefined,
            recorderVersion: event.recorderVersion,
        },
    };
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
    overrides?: { reason?: string[]; warnings?: string[]; confidence?: number },
): Pick<RecordedStepEnhancement, 'resolveHint' | 'resolvePolicy'> => ({
    resolveHint: {
        raw: {
            selector: event.selector,
            locatorCandidates: event.locatorCandidates?.map((candidate) => ({ ...candidate })),
            scopeHint: event.scopeHint || undefined,
            targetHint: event.targetHint,
        },
        capture: {
            source: 'record_enrichment',
            confidence: overrides?.confidence ?? 0.25,
            reason: overrides?.reason || ['raw_selector_or_text_only_without_snapshot'],
            warnings: overrides?.warnings || ['LOW_CONFIDENCE_RAW_ONLY'],
        },
    },
    resolvePolicy: {
        preferDirect: true,
        requireVisible: true,
        allowFuzzy: true,
        allowIndexDrift: true,
    },
});

const computeRecordConfidence = (
    event: RecorderEvent,
    snapshot: SnapshotResult,
    nodeId: string,
): { confidence: number; reason: string[]; warnings: string[] } => {
    const locator = snapshot.locatorIndex[nodeId];
    const role = normalizeText(snapshot.nodeIndex[nodeId]?.role);
    const name = normalizeText(snapshot.nodeIndex[nodeId]?.name);
    const reasons: string[] = [];
    const warnings: string[] = [];
    let confidence = 0.45;
    if (event.selector && locator?.direct?.query && normalizeText(event.selector) === normalizeText(locator.direct.query)) {
        confidence = 0.95;
        reasons.push('direct_selector_exact_match');
    } else if (event.a11yHint?.role && event.a11yHint?.name && normalizeText(event.a11yHint.role) === role && name.includes(normalizeText(event.a11yHint.name))) {
        confidence = 0.8;
        reasons.push('role_and_name_match');
    } else if (event.selector) {
        confidence = 0.5;
        reasons.push('raw_selector_only');
    } else {
        confidence = 0.35;
        reasons.push('text_or_a11y_only');
    }
    if ((event.locatorCandidates || []).length > 1) {
        confidence = Math.max(0.2, confidence - 0.15);
        warnings.push('AMBIGUOUS_TARGET');
    }
    if (confidence < 0.55) {
        warnings.push('LOW_CONFIDENCE_RAW_ONLY');
    }
    return { confidence, reason: reasons, warnings };
};
