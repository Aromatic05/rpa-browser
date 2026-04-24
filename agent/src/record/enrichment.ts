import type { Page } from 'playwright';
import type { RecorderEvent } from './recorder';
import { generateSemanticSnapshot } from '../runner/steps/executors/snapshot/pipeline/snapshot';
import { getNodeSemanticHints } from '../runner/steps/executors/snapshot/core/runtime_store';
import type { SnapshotResult, UnifiedNode } from '../runner/steps/executors/snapshot/core/types';
import type { ResolveHint } from '../runner/steps/types';
import type { RecordedEntityBinding, RecordedStepEnhancement, RecordedTargetFingerprint } from './types';

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
    const snapshot = await resolveSnapshotForEvent({ event, page, snapshotCache, cacheKey });
    if (!snapshot) {
        return withRawContext(event);
    }

    const bestNodeId = pickBestNodeId(snapshot, event);
    if (!bestNodeId) {
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

    const node = snapshot.nodeIndex[bestNodeId];
    if (!node) {return withRawContext(event);}

    const locator = snapshot.locatorIndex[bestNodeId];
    const target = buildTargetFingerprint(snapshot, node, bestNodeId, locator?.origin);
    const entityBindings = buildEntityBindings(snapshot, bestNodeId);
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
        resolveHint: {
            target: {
                nodeId: target.nodeId,
                primaryDomId: target.primaryDomId,
                sourceDomIds: target.sourceDomIds,
                role: target.role,
                tag: target.tag,
                name: target.name,
                text: target.content,
            },
            locator: locator
                ? {
                      direct: locator.direct
                          ? {
                                kind: locator.direct.kind,
                                query: locator.direct.query,
                                fallback: locator.direct.fallback,
                            }
                          : undefined,
                      scope: locator.scope
                          ? {
                                id: locator.scope.id,
                                kind: locator.scope.kind,
                            }
                          : undefined,
                      origin: {
                          primaryDomId: locator.origin?.primaryDomId,
                          sourceDomIds: locator.origin?.sourceDomIds,
                      },
                  }
                : undefined,
        },
        resolvePolicy: locator?.policy
            ? {
                  preferDirect: locator.policy.preferDirect,
                  preferScoped: locator.policy.preferScopedSearch,
                  requireVisible: locator.policy.requireVisible,
                  allowFuzzy: locator.policy.allowFuzzy,
                  allowIndexDrift: locator.policy.allowIndexDrift,
              }
            : undefined,
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
    if (event.type === 'navigate' || event.type === 'scroll' || event.type === 'copy') {return false;}
    return true;
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
                role: existingHint?.target?.role || event.a11yHint?.role,
                name: existingHint?.target?.name || event.a11yHint?.name,
                text: existingHint?.target?.text || event.a11yHint?.text,
            },
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
    const attrs = snapshot.attrIndex[nodeId];
    const semanticHints = getNodeSemanticHints(node);
    return {
        nodeId,
        primaryDomId: origin?.primaryDomId,
        sourceDomIds: origin?.sourceDomIds,
        role: node.role,
        tag: attrs?.tag || attrs?.tagName,
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
            kind: entity?.kind,
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

const pickBestNodeId = (snapshot: SnapshotResult, event: RecorderEvent): string | undefined => {
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestNodeId: string | undefined;

    for (const [nodeId, node] of Object.entries(snapshot.nodeIndex)) {
        const score = scoreNode(snapshot, nodeId, node, event);
        if (score > bestScore) {
            bestScore = score;
            bestNodeId = nodeId;
        }
    }

    if (bestScore < 12) {return undefined;}
    return bestNodeId;
};

const scoreNode = (snapshot: SnapshotResult, nodeId: string, node: UnifiedNode, event: RecorderEvent): number => {
    const locator = snapshot.locatorIndex[nodeId];
    const attrs = snapshot.attrIndex[nodeId] || {};
    const tag = normalizeText(attrs.tag || attrs.tagName);
    const name = normalizeText(node.name);
    const content = normalizeText(resolveNodeContent(snapshot, node));
    let score = 0;

    if (event.selector) {
        const selector = normalizeText(event.selector);
        if (selector) {
            const directQuery = normalizeText(locator?.direct?.query);
            const directFallback = normalizeText(locator?.direct?.fallback);
            if (selector === directQuery || selector === directFallback) {score += 80;}
            if (directQuery && (selector.includes(directQuery) || directQuery.includes(selector))) {score += 30;}
            if (directFallback && (selector.includes(directFallback) || directFallback.includes(selector))) {score += 25;}
            if (attrs.id && selector.includes(`#${attrs.id}`)) {score += 20;}
            const testId = attrs['data-testid'] || attrs['data-test-id'] || attrs['data-test'] || attrs['data-qa'];
            if (testId && selector.includes(String(testId))) {score += 24;}
        }
    }

    score += scoreByA11yHint(event.a11yHint, node.role, name, content);
    score += scoreByCandidates(event, node.role, tag, name, content, attrs, locator?.direct?.query);

    if (event.targetHint && tag && normalizeText(event.targetHint) === tag) {score += 6;}

    return score;
};

const scoreByA11yHint = (
    hint: { role?: string; name?: string; text?: string } | undefined,
    role: string | undefined,
    name: string | undefined,
    content: string | undefined,
): number => {
    if (!hint) {return 0;}
    let score = 0;
    const roleNorm = normalizeText(role);
    const hintRole = normalizeText(hint.role);
    if (hintRole) {
        if (hintRole === roleNorm) {score += 28;}
        else {score -= 14;}
    }

    const mergedText = `${name || ''} ${content || ''}`.trim();
    const hintName = normalizeText(hint.name);
    if (hintName) {
        if (mergedText.includes(hintName)) {score += 34;}
        else {score -= 10;}
    }

    const hintText = normalizeText(hint.text);
    if (hintText) {
        if (mergedText.includes(hintText)) {score += 22;}
        else {score -= 8;}
    }

    return score;
};

const scoreByCandidates = (
    event: RecorderEvent,
    role: string | undefined,
    tag: string | undefined,
    name: string | undefined,
    content: string | undefined,
    attrs: Record<string, string>,
    directQuery: string | undefined,
): number => {
    const candidates = event.locatorCandidates || [];
    if (!candidates.length) {return 0;}
    let score = 0;
    const mergedText = `${name || ''} ${content || ''}`.trim();

    for (const candidate of candidates) {
        if (candidate.kind === 'css') {
            const selector = normalizeText(candidate.selector);
            if (!selector) {continue;}
            if (selector === normalizeText(directQuery)) {score += 25;}
            else if (directQuery && selector.includes(normalizeText(directQuery) || '')) {score += 12;}
            continue;
        }

        if (candidate.kind === 'testid') {
            const actualTestId = attrs['data-testid'] || attrs['data-test-id'] || attrs['data-test'] || attrs['data-qa'];
            if (actualTestId && normalizeText(candidate.testId) === normalizeText(actualTestId)) {score += 30;}
            continue;
        }

        if (candidate.kind === 'role') {
            if (normalizeText(candidate.role) === normalizeText(role)) {score += 18;}
            if (candidate.name && mergedText.includes(normalizeText(candidate.name) || '')) {score += 16;}
            continue;
        }

        if (candidate.kind === 'label' || candidate.kind === 'text' || candidate.kind === 'placeholder') {
            const text = normalizeText(candidate.text);
            if (text && mergedText.includes(text)) {score += 12;}
            if (candidate.kind === 'placeholder' && text && normalizeText(attrs.placeholder)?.includes(text)) {score += 10;}
            continue;
        }

        if (candidate.kind === 'role' && tag && normalizeText(candidate.role) === tag) {
            score += 8;
        }
    }

    return score;
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
