import type { RawCapturedNode, RawCapturedScope, RawPageCapture } from '../capture/contracts';
import { RUNTIME_STATE_ATTRIBUTE } from '../capture/runtime_state';
import type {
    AccessibilityRecord,
    ActivityFacts,
    AnalysisDiagnostic,
    GeometryRecord,
    ObservationNodeId,
    PageObservation,
    Rect,
    RectTransform,
    RuntimeStateRecord,
    ScopeForest,
    TreeScope,
    TreeScopeId,
} from './contracts';
import { deepFreeze } from './freeze';

const OBSERVATION_MARKER_ATTRIBUTE = 'data-rpa-observation-id';
const INTERNAL_CAPTURE_ATTRIBUTES = new Set([RUNTIME_STATE_ATTRIBUTE, OBSERVATION_MARKER_ATTRIBUTE]);
const IDENTITY_TRANSFORM: RectTransform = {
    scaleX: 1,
    scaleY: 1,
    translateX: 0,
    translateY: 0,
};

export const buildPageObservation = (capture: RawPageCapture): PageObservation => {
    const diagnostics: AnalysisDiagnostic[] = [...capture.diagnostics];
    const captureIdToNodeId: Record<string, ObservationNodeId> = {};
    const rawNodeByCaptureId = new Map<string, RawCapturedNode>();
    const scopeOrder = new Map<TreeScopeId, number>();
    const localOrderByScope = new Map<TreeScopeId, number>();

    capture.scopes.forEach((scope, index) => scopeOrder.set(scope.id, index));

    for (const rawNode of capture.nodes) {
        if (rawNodeByCaptureId.has(rawNode.captureId)) {
            diagnostics.push({
                code: 'observation.capture-id.duplicate',
                severity: 'error',
                stage: 'observation',
                nodeIds: [],
                evidence: [],
                message: `duplicate capture node id: ${rawNode.captureId}`,
            });
            continue;
        }
        rawNodeByCaptureId.set(rawNode.captureId, rawNode);
        const localOrder = localOrderByScope.get(rawNode.scopeId) ?? 0;
        localOrderByScope.set(rawNode.scopeId, localOrder + 1);
        const scopeIndex = scopeOrder.get(rawNode.scopeId) ?? capture.scopes.length;
        captureIdToNodeId[rawNode.captureId] = `obs:${scopeIndex}:${localOrder}`;
    }

    const nodes: Record<string, PageObservation['nodes'][string]> = {};
    const parents: Record<string, ObservationNodeId | undefined> = {};
    const children: Record<string, ObservationNodeId[]> = {};
    const documentOrder: Record<string, number> = {};
    const attributes: Record<string, Record<string, string>> = {};
    const text: Record<string, string | undefined> = {};
    const accessibility: Record<string, AccessibilityRecord | undefined> = {};
    const runtimeState: Record<string, RuntimeStateRecord | undefined> = {};
    const geometry: Record<string, GeometryRecord[]> = {};
    const activity: Record<string, ActivityFacts> = {};
    const domIdentity: Record<string, PageObservation['domIdentity'][string]> = {};
    const layers: Record<string, PageObservation['layers'][string]> = {};

    const a11yByBackendId = indexAccessibility(capture.accessibility);
    const nodeIdsByRuntimeToken = indexRuntimeTokens(capture.nodes, captureIdToNodeId);
    const scopeTransforms = buildTopTransforms(capture.scopes, diagnostics);
    const reportedRuntimeAmbiguities = new Set<string>();

    capture.nodes.forEach((rawNode, order) => {
        const nodeId = captureIdToNodeId[rawNode.captureId];
        if (!nodeId) {return;}

        const parentNodeId = rawNode.parentCaptureId
            ? captureIdToNodeId[rawNode.parentCaptureId]
            : undefined;
        const childNodeIds = rawNode.childCaptureIds
            .map((captureId) => captureIdToNodeId[captureId])
            .filter((childId): childId is ObservationNodeId => Boolean(childId));
        const runtimeToken = readRuntimeStateToken(rawNode);

        nodes[nodeId] = {
            id: nodeId,
            scopeId: rawNode.scopeId,
            tag: normalizeTag(rawNode.tag),
        };
        parents[nodeId] = parentNodeId;
        children[nodeId] = childNodeIds;
        documentOrder[nodeId] = order;
        attributes[nodeId] = filterPageAttributes(rawNode.attributes);
        text[nodeId] = normalize(rawNode.ownText) || undefined;
        layers[nodeId] = { scopeId: rawNode.scopeId };
        domIdentity[nodeId] = {
            captureId: rawNode.captureId,
            backendNodeId: normalize(rawNode.backendNodeId) || undefined,
            runtimeIdentityToken: runtimeToken || undefined,
        };

        accessibility[nodeId] = resolveAccessibility(
            nodeId,
            rawNode.backendNodeId,
            a11yByBackendId,
            diagnostics,
        );
        runtimeState[nodeId] = resolveRuntimeState(
            nodeId,
            runtimeToken,
            capture.runtimeState,
            nodeIdsByRuntimeToken,
            reportedRuntimeAmbiguities,
            diagnostics,
        );
        geometry[nodeId] = buildGeometryRecords(
            rawNode,
            capture.identity.captureRevision,
            scopeTransforms.get(rawNode.scopeId),
        );
        activity[nodeId] = {
            hiddenByStyle: rawNode.activity.hiddenByStyle,
            inert: rawNode.activity.inert,
            ariaExposed: rawNode.activity.ariaExposed,
            selfHasBox: rawNode.activity.selfHasBox,
            subtreeActive: false,
            rendered: rawNode.activity.rendered,
        };
    });

    const scopes = buildScopeForest(
        capture.scopes,
        captureIdToNodeId,
        capture.completeness,
        diagnostics,
    );
    computeSubtreeActivity({
        scopes,
        children,
        activity,
    });

    const observation: PageObservation = {
        identity: { ...capture.identity },
        scopes,
        completeness: { ...capture.completeness },
        nodes,
        parents,
        children,
        documentOrder,
        attributes,
        text,
        accessibility,
        runtimeState,
        geometry,
        activity,
        domIdentity,
        layers,
        captureIdToNodeId,
        diagnostics,
    };

    return deepFreeze(observation);
};

const indexAccessibility = (
    records: readonly AccessibilityRecord[],
): Map<string, AccessibilityRecord[]> => {
    const index = new Map<string, AccessibilityRecord[]>();
    for (const record of records) {
        const backendNodeId = normalize(record.backendNodeId);
        if (!backendNodeId) {continue;}
        const bucket = index.get(backendNodeId) ?? [];
        bucket.push({ ...record, backendNodeId });
        index.set(backendNodeId, bucket);
    }
    return index;
};

const indexRuntimeTokens = (
    rawNodes: readonly RawCapturedNode[],
    captureIdToNodeId: Readonly<Record<string, ObservationNodeId>>,
): Map<string, ObservationNodeId[]> => {
    const index = new Map<string, ObservationNodeId[]>();
    for (const rawNode of rawNodes) {
        const token = readRuntimeStateToken(rawNode);
        const nodeId = captureIdToNodeId[rawNode.captureId];
        if (!token || !nodeId) {continue;}
        const bucket = index.get(token) ?? [];
        bucket.push(nodeId);
        index.set(token, bucket);
    }
    return index;
};

const resolveAccessibility = (
    nodeId: ObservationNodeId,
    backendNodeId: string | undefined,
    index: ReadonlyMap<string, AccessibilityRecord[]>,
    diagnostics: AnalysisDiagnostic[],
): AccessibilityRecord | undefined => {
    const normalizedBackendId = normalize(backendNodeId);
    if (!normalizedBackendId) {return undefined;}
    const candidates = index.get(normalizedBackendId) ?? [];
    if (candidates.length === 0) {return undefined;}

    const strongCandidates = candidates.filter((candidate) => !isWeakAccessibilityRole(candidate.role));
    const eligible = strongCandidates.length > 0 ? strongCandidates : candidates;
    if (eligible.length === 1) {
        return { ...eligible[0] };
    }

    diagnostics.push({
        code: 'observation.join.a11y.ambiguous',
        severity: 'warning',
        stage: 'observation',
        status: 'ambiguous',
        nodeIds: [nodeId],
        evidence: [
            {
                code: 'a11y.backend-node-id.multiple',
                strength: 'exact',
                source: 'platform',
                nodeIds: [nodeId],
                detail: {
                    backendNodeId: normalizedBackendId,
                    axNodeIds: eligible.map((candidate) => candidate.axNodeId),
                },
            },
        ],
        message: `multiple accessibility nodes share backend node id ${normalizedBackendId}`,
    });
    return undefined;
};

const resolveRuntimeState = (
    nodeId: ObservationNodeId,
    runtimeToken: string,
    runtimeStateByToken: Readonly<Record<string, RuntimeStateRecord | undefined>>,
    nodeIdsByToken: ReadonlyMap<string, ObservationNodeId[]>,
    reportedAmbiguities: Set<string>,
    diagnostics: AnalysisDiagnostic[],
): RuntimeStateRecord | undefined => {
    if (!runtimeToken) {return undefined;}
    const joinedNodeIds = nodeIdsByToken.get(runtimeToken) ?? [];
    if (joinedNodeIds.length > 1) {
        if (!reportedAmbiguities.has(runtimeToken)) {
            reportedAmbiguities.add(runtimeToken);
            diagnostics.push({
                code: 'observation.join.runtime.ambiguous',
                severity: 'error',
                stage: 'observation',
                status: 'ambiguous',
                nodeIds: [...joinedNodeIds],
                evidence: [
                    {
                        code: 'runtime.state-token.multiple-nodes',
                        strength: 'exact',
                        source: 'runtime',
                        nodeIds: [...joinedNodeIds],
                        detail: { runtimeToken },
                    },
                ],
                message: `runtime state token ${runtimeToken} is attached to multiple DOM nodes`,
            });
        }
        return undefined;
    }

    const record = runtimeStateByToken[runtimeToken];
    if (!record) {return undefined;}
    return { ...record, stateId: runtimeToken };
};

const buildScopeForest = (
    rawScopes: readonly RawCapturedScope[],
    captureIdToNodeId: Readonly<Record<string, ObservationNodeId>>,
    defaultCompleteness: RawPageCapture['completeness'],
    diagnostics: AnalysisDiagnostic[],
): ScopeForest => {
    const scopes: Record<TreeScopeId, TreeScope> = {};
    const rootScopeIds: TreeScopeId[] = [];

    for (const rawScope of rawScopes) {
        if (scopes[rawScope.id]) {
            diagnostics.push({
                code: 'observation.scope.duplicate',
                severity: 'error',
                stage: 'observation',
                nodeIds: [],
                evidence: [],
                message: `duplicate scope id: ${rawScope.id}`,
            });
            continue;
        }
        const rootNodeId = captureIdToNodeId[rawScope.rootCaptureId];
        const hostNodeId = rawScope.hostCaptureId
            ? captureIdToNodeId[rawScope.hostCaptureId]
            : undefined;
        if (!rootNodeId) {
            diagnostics.push({
                code: 'observation.scope.root-missing',
                severity: 'error',
                stage: 'observation',
                nodeIds: hostNodeId ? [hostNodeId] : [],
                evidence: [],
                message: `scope ${rawScope.id} root capture node is missing`,
            });
            continue;
        }

        scopes[rawScope.id] = {
            id: rawScope.id,
            kind: rawScope.kind,
            parentScopeId: rawScope.parentScopeId,
            hostNodeId,
            rootNodeId,
            status: rawScope.status,
            unavailableReason: rawScope.unavailableReason,
            transformToParent: rawScope.transformToParent
                ? { ...rawScope.transformToParent }
                : undefined,
            completeness: rawScope.completeness
                ? { ...rawScope.completeness }
                : rawScope.status === 'unavailable'
                    ? { dom: 'unavailable', a11y: 'unavailable', runtime: 'unavailable', geometry: 'unavailable' }
                    : { ...defaultCompleteness },
        };
        if (!rawScope.parentScopeId) {
            rootScopeIds.push(rawScope.id);
        }
    }

    return {
        scopes,
        rootScopeIds,
    };
};

const buildTopTransforms = (
    rawScopes: readonly RawCapturedScope[],
    diagnostics: AnalysisDiagnostic[],
): Map<TreeScopeId, RectTransform> => {
    const byId = new Map(rawScopes.map((scope) => [scope.id, scope] as const));
    const cache = new Map<TreeScopeId, RectTransform>();
    const resolving = new Set<TreeScopeId>();

    const resolve = (scopeId: TreeScopeId): RectTransform => {
        const cached = cache.get(scopeId);
        if (cached) {return cached;}
        if (resolving.has(scopeId)) {
            diagnostics.push({
                code: 'observation.scope.transform-cycle',
                severity: 'error',
                stage: 'observation',
                nodeIds: [],
                evidence: [],
                message: `scope transform cycle detected at ${scopeId}`,
            });
            return IDENTITY_TRANSFORM;
        }

        resolving.add(scopeId);
        const scope = byId.get(scopeId);
        const localTransform = scope?.transformToParent ?? IDENTITY_TRANSFORM;
        const topTransform = scope?.parentScopeId
            ? composeTransforms(resolve(scope.parentScopeId), localTransform)
            : { ...IDENTITY_TRANSFORM };
        resolving.delete(scopeId);
        cache.set(scopeId, topTransform);
        return topTransform;
    };

    for (const scope of rawScopes) {
        resolve(scope.id);
    }
    return cache;
};

const composeTransforms = (
    parentToTop: RectTransform,
    localToParent: RectTransform,
): RectTransform => ({
    scaleX: localToParent.scaleX * parentToTop.scaleX,
    scaleY: localToParent.scaleY * parentToTop.scaleY,
    translateX: localToParent.translateX * parentToTop.scaleX + parentToTop.translateX,
    translateY: localToParent.translateY * parentToTop.scaleY + parentToTop.translateY,
});

const buildGeometryRecords = (
    rawNode: RawCapturedNode,
    captureRevision: number,
    transformToTop: RectTransform | undefined,
): GeometryRecord[] => {
    if (!rawNode.geometry) {return [];}
    const source = rawNode.geometrySource ?? 'live-dom';
    const local: GeometryRecord = {
        rect: { ...rawNode.geometry },
        space: 'scope-viewport',
        scopeId: rawNode.scopeId,
        captureRevision,
        source,
    };
    const transform = transformToTop ?? IDENTITY_TRANSFORM;
    const top: GeometryRecord = {
        rect: transformRect(rawNode.geometry, transform),
        space: 'top-css-viewport',
        scopeId: rawNode.scopeId,
        captureRevision,
        source,
        frameTransform: isIdentityTransform(transform) ? undefined : { ...transform },
    };
    return [local, top];
};

const transformRect = (rect: Rect, transform: RectTransform): Rect => ({
    x: rect.x * transform.scaleX + transform.translateX,
    y: rect.y * transform.scaleY + transform.translateY,
    width: rect.width * transform.scaleX,
    height: rect.height * transform.scaleY,
});

const isIdentityTransform = (transform: RectTransform): boolean =>
    transform.scaleX === 1
    && transform.scaleY === 1
    && transform.translateX === 0
    && transform.translateY === 0;

const computeSubtreeActivity = (input: {
    scopes: ScopeForest;
    children: Readonly<Record<ObservationNodeId, ObservationNodeId[]>>;
    activity: Record<ObservationNodeId, ActivityFacts>;
}) => {
    const externalRootsByHost = new Map<ObservationNodeId, ObservationNodeId[]>();
    for (const scope of Object.values(input.scopes.scopes)) {
        if (!scope.hostNodeId || scope.status !== 'captured') {continue;}
        const bucket = externalRootsByHost.get(scope.hostNodeId) ?? [];
        bucket.push(scope.rootNodeId);
        externalRootsByHost.set(scope.hostNodeId, bucket);
    }

    const memo = new Map<ObservationNodeId, boolean>();
    const visiting = new Set<ObservationNodeId>();
    const visit = (
        nodeId: ObservationNodeId,
        inheritedHidden: boolean,
        inheritedInert: boolean,
    ): boolean => {
        const cached = memo.get(nodeId);
        if (cached !== undefined && !inheritedHidden && !inheritedInert) {return cached;}
        if (visiting.has(nodeId)) {return false;}
        visiting.add(nodeId);

        const facts = input.activity[nodeId];
        if (!facts) {
            visiting.delete(nodeId);
            return false;
        }
        const hidden = inheritedHidden || facts.hiddenByStyle;
        const inert = inheritedInert || facts.inert;
        let hasActiveDescendant = false;
        const childIds = [
            ...(input.children[nodeId] ?? []),
            ...(externalRootsByHost.get(nodeId) ?? []),
        ];
        for (const childId of childIds) {
            if (visit(childId, hidden, inert)) {
                hasActiveDescendant = true;
            }
        }

        const rendered = facts.rendered && !hidden;
        const subtreeActive = !hidden && !inert && rendered && (facts.selfHasBox || hasActiveDescendant);
        input.activity[nodeId] = {
            ...facts,
            rendered,
            subtreeActive,
        };
        visiting.delete(nodeId);
        if (!inheritedHidden && !inheritedInert) {
            memo.set(nodeId, subtreeActive);
        }
        return subtreeActive;
    };

    for (const rootScopeId of input.scopes.rootScopeIds) {
        const rootNodeId = input.scopes.scopes[rootScopeId]?.rootNodeId;
        if (rootNodeId) {
            visit(rootNodeId, false, false);
        }
    }
};

const readRuntimeStateToken = (rawNode: RawCapturedNode): string =>
    normalize(rawNode.runtimeStateToken ?? rawNode.attributes[RUNTIME_STATE_ATTRIBUTE]);

const filterPageAttributes = (
    rawAttributes: Readonly<Record<string, string>>,
): Record<string, string> => Object.fromEntries(
    Object.entries(rawAttributes).filter(([name]) => !INTERNAL_CAPTURE_ATTRIBUTES.has(name.toLowerCase())),
);

const isWeakAccessibilityRole = (role: string | undefined): boolean => {
    const normalized = normalize(role).toLowerCase();
    return !normalized || WEAK_ACCESSIBILITY_ROLES.has(normalized);
};

const normalize = (value: string | undefined): string => (value ?? '').trim();
const normalizeTag = (value: string): string => normalize(value).toLowerCase() || 'generic';

const WEAK_ACCESSIBILITY_ROLES = new Set([
    'generic',
    'none',
    'presentation',
    'ignored',
    'unknown',
]);
