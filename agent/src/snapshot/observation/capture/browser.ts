/* eslint-disable @typescript-eslint/no-unnecessary-condition -- CDP responses are runtime data and may omit fields despite generated protocol typings. */
import type { Frame, Page } from 'playwright';
import {
    cleanupTaggedRuntimeState,
    collectTaggedRuntimeStateCapture,
    createRuntimeStateEpoch,
    RUNTIME_STATE_ATTRIBUTE,
} from '../model/runtime_state';
import { analyzePageObservation } from '../analysis/build';
import { buildPageObservation } from '../model/build';
import { ObservationIdentityTracker } from '../model/identity';
import type {
    AccessibilityRecord,
    AnalysisDiagnostic,
    PageObservation,
    RectTransform,
} from '../model/contracts';
import type { PageObservationAnalysis } from '../analysis/contracts';
import type {
    RawCapturedNode,
    RawCapturedScope,
    RawPageCapture,
    RawPageCaptureResult,
} from '../model/raw_capture';

export type BrowserObservationCaptureOptions = {
    captureRuntimeState?: boolean;
    sourceMetadata?: {
        framework?: string;
        frameworkVersion?: string;
    };
};

type FrameCapturePayload = {
    nodes: RawCapturedNode[];
    scopes: RawCapturedScope[];
    restorations: Array<{
        marker: string;
        previousValue?: string;
    }>;
    viewport: {
        width: number;
        height: number;
    };
};

type CapturedFrame = {
    frame: Frame;
    frameIndex: number;
    documentScopeId: string;
    hostCaptureId?: string;
    payload?: FrameCapturePayload;
    unavailableReason?: string;
};

type DomSnapshotCaptureResult = {
    documents?: Array<{
        nodes?: {
            backendNodeId?: number[];
            attributes?: number[][];
        };
    }>;
    strings?: string[];
};

type CdpAccessibilityNode = {
    nodeId: string;
    backendDOMNodeId?: number;
    ignored?: boolean;
    role?: { value?: unknown };
    name?: { value?: unknown };
    description?: { value?: unknown };
    value?: { value?: unknown };
    properties?: Array<{
        name?: string;
        value?: { value?: unknown };
    }>;
};

const identityTrackerByPage = new WeakMap<Page, ObservationIdentityTracker>();
const OBSERVATION_MARKER_ATTRIBUTE = 'data-rpa-observation-id';

export const captureRawPage = async (
    page: Page,
    options: BrowserObservationCaptureOptions = {},
): Promise<RawPageCaptureResult> => {
    await settlePage(page);

    const identity = getIdentityTracker(page).next(await readDocumentToken(page));
    const captureRunId = `${identity.pageEpoch}:${identity.captureRevision}`;
    const diagnostics: AnalysisDiagnostic[] = [];
    const cleanupActions: Array<() => Promise<void>> = [];

    let runtimeState: RawPageCapture['runtimeState'] = {};
    let runtimeStatus: RawPageCapture['completeness']['runtime'] = 'unavailable';
    if (options.captureRuntimeState) {
        const runtimeEpoch = createRuntimeStateEpoch();
        const runtimeCapture = await collectTaggedRuntimeStateCapture(page, runtimeEpoch);
        runtimeState = runtimeCapture.records;
        runtimeStatus = runtimeCapture.status;
        if (runtimeCapture.status === 'unavailable') {
            diagnostics.push(captureDiagnostic(
                'capture.runtime.failed',
                'runtime state collection failed',
                runtimeCapture.error,
            ));
        } else if (runtimeCapture.status === 'partial') {
            diagnostics.push(captureDiagnostic(
                'capture.runtime.partial',
                `runtime state collection was partial: ${runtimeCapture.partialReasons.join(', ')}`,
            ));
        }
        cleanupActions.push(async () => {
            await cleanupTaggedRuntimeState(page, runtimeEpoch).catch(() => undefined);
        });
    }

    const capturedFrames = await captureFrames(page, captureRunId, diagnostics);
    cleanupActions.push(async () => {
        await restoreObservationMarkers(capturedFrames).catch(() => undefined);
    });

    const backendNodeIdByMarker = await captureBackendNodeIds(page, diagnostics);
    const accessibilityCapture = await captureAccessibility(page, diagnostics);
    const { scopes, nodes, domStatus, geometryStatus } = assembleFrames(
        capturedFrames,
        backendNodeIdByMarker,
        diagnostics,
    );

    const capture: RawPageCapture = {
        identity,
        metadata: {
            schemaVersion: 1,
            source: 'browser-live',
            capturedAt: new Date().toISOString(),
            pageUrl: page.url(),
            framework: options.sourceMetadata?.framework,
            frameworkVersion: options.sourceMetadata?.frameworkVersion,
        },
        completeness: {
            dom: domStatus,
            a11y: accessibilityCapture.status,
            runtime: runtimeStatus,
            geometry: geometryStatus,
        },
        scopes: scopes.map((scope) => ({
            ...scope,
            completeness: scope.status === 'unavailable'
                ? { dom: 'unavailable', a11y: 'unavailable', runtime: 'unavailable', geometry: 'unavailable' }
                : {
                    dom: domStatus,
                    a11y: accessibilityCapture.status,
                    runtime: runtimeStatus,
                    geometry: geometryStatus,
                },
        })),
        nodes,
        accessibility: accessibilityCapture.records,
        runtimeState,
        diagnostics,
    };

    return {
        capture,
        cleanup: async () => {
            for (const cleanupAction of cleanupActions.reverse()) {
                await cleanupAction().catch(() => undefined);
            }
        },
    };
};

export const capturePageObservation = async (
    page: Page,
    options: BrowserObservationCaptureOptions = {},
): Promise<PageObservation> => {
    const result = await captureRawPage(page, options);
    try {
        return buildPageObservation(result.capture);
    } finally {
        await result.cleanup();
    }
};

export const captureAndAnalyzePageObservation = async (
    page: Page,
    options: BrowserObservationCaptureOptions = {},
): Promise<PageObservationAnalysis> => {
    const result = await captureRawPage(page, options);
    try {
        return analyzePageObservation(buildPageObservation(result.capture));
    } finally {
        await result.cleanup();
    }
};

const getIdentityTracker = (page: Page): ObservationIdentityTracker => {
    const current = identityTrackerByPage.get(page);
    if (current) {return current;}
    const created = new ObservationIdentityTracker();
    identityTrackerByPage.set(page, created);
    return created;
};

const readDocumentToken = async (page: Page): Promise<string> => {
    const token = await page.evaluate(`(() => {
        const key = '__RPA_OBSERVATION_DOCUMENT_TOKEN__';
        const scope = globalThis;
        if (!scope[key]) {
            const random = Math.random().toString(36).slice(2);
            const timeOrigin = globalThis.performance && Number.isFinite(globalThis.performance.timeOrigin)
                ? globalThis.performance.timeOrigin.toString(36)
                : Date.now().toString(36);
            scope[key] = timeOrigin + ':' + random;
        }
        return String(scope[key]);
    })()`);
    if (typeof token !== 'string' || !token.trim()) {
        throw new Error('unable to establish page document identity');
    }
    return token;
};

const settlePage = async (page: Page): Promise<void> => {
    await page.waitForLoadState('domcontentloaded', { timeout: 2500 }).catch(() => undefined);
    await page.evaluate(`(() => new Promise((resolve) => {
        const next = () => new Promise((done) => {
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => done());
            } else {
                setTimeout(done, 0);
            }
        });
        next().then(next).then(resolve);
    }))()`).catch(() => undefined);
};

const captureFrames = async (
    page: Page,
    captureRunId: string,
    diagnostics: AnalysisDiagnostic[],
): Promise<CapturedFrame[]> => {
    const frames = page.frames();
    const capturedFrames: CapturedFrame[] = [];

    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
        const frame = frames[frameIndex];
        const documentScopeId = `scope:frame:${frameIndex}:document`;
        try {
            const payload = await frame.evaluate(
                ({ script, input }) => {
                    const capture = (0, eval)(script) as (value: unknown) => unknown;
                    return capture(input);
                },
                {
                    script: FRAME_CAPTURE_SCRIPT,
                    input: {
                        captureRunId,
                        frameIndex,
                        documentScopeId,
                        markerAttribute: OBSERVATION_MARKER_ATTRIBUTE,
                        stateAttribute: RUNTIME_STATE_ATTRIBUTE,
                    },
                },
            ) as FrameCapturePayload;
            capturedFrames.push({ frame, frameIndex, documentScopeId, payload });
        } catch (error) {
            const unavailableReason = errorMessage(error);
            diagnostics.push(captureDiagnostic(
                'capture.frame.unavailable',
                `frame ${frameIndex} could not be captured`,
                error,
            ));
            capturedFrames.push({
                frame,
                frameIndex,
                documentScopeId,
                unavailableReason,
            });
        }
    }
    for (const captured of capturedFrames) {
        if (!captured.frame.parentFrame()) {continue;}
        captured.hostCaptureId = await captured.frame
            .frameElement()
            .then((element) => element.getAttribute(OBSERVATION_MARKER_ATTRIBUTE))
            .then((value) => value?.trim() || undefined)
            .catch((error: unknown) => {
                diagnostics.push(captureDiagnostic(
                    'capture.frame.host-unresolved',
                    `frame ${captured.frameIndex} host could not be resolved exactly`,
                    error,
                ));
                return undefined;
            });
    }
    return capturedFrames;
};

const assembleFrames = (
    capturedFrames: readonly CapturedFrame[],
    backendNodeIdByMarker: ReadonlyMap<string, string>,
    diagnostics: AnalysisDiagnostic[],
): {
    scopes: RawCapturedScope[];
    nodes: RawCapturedNode[];
    domStatus: RawPageCapture['completeness']['dom'];
    geometryStatus: RawPageCapture['completeness']['geometry'];
} => {
    const scopes: RawCapturedScope[] = [];
    const nodes: RawCapturedNode[] = [];
    const documentScopeByFrame = new Map<Frame, string>(
        capturedFrames.map((captured) => [captured.frame, captured.documentScopeId]),
    );
    let unavailableCount = 0;
    let nodeWithoutGeometryCount = 0;

    for (const captured of capturedFrames) {
        const parentFrame = captured.frame.parentFrame();
        const parentScopeId = parentFrame ? documentScopeByFrame.get(parentFrame) : undefined;
        const hostCaptureId = parentFrame ? captured.hostCaptureId : undefined;

        const frameTransform = parentFrame
            ? deriveFrameTransform(captured, capturedFrames, parentFrame)
            : undefined;

        if (!captured.payload) {
            unavailableCount += 1;
            const rootCaptureId = `capture:frame:${captured.frameIndex}:unavailable-root`;
            nodes.push({
                captureId: rootCaptureId,
                scopeId: captured.documentScopeId,
                childCaptureIds: [],
                tag: '#unavailable-document',
                attributes: {},
                activity: {
                    hiddenByStyle: true,
                    inert: false,
                    selfHasBox: false,
                    rendered: false,
                },
            });
            scopes.push({
                id: captured.documentScopeId,
                kind: parentFrame ? 'iframe' : 'document',
                parentScopeId,
                hostCaptureId,
                rootCaptureId,
                status: 'unavailable',
                unavailableReason: captured.unavailableReason ?? 'capture failed',
                transformToParent: frameTransform,
            });
            continue;
        }

        for (const rawNode of captured.payload.nodes) {
            const backendNodeId = backendNodeIdByMarker.get(rawNode.captureId);
            nodes.push({
                ...rawNode,
                backendNodeId,
            });
            if (!rawNode.geometry) {
                nodeWithoutGeometryCount += 1;
            }
        }
        for (const rawScope of captured.payload.scopes) {
            if (rawScope.id === captured.documentScopeId) {
                scopes.push({
                    ...rawScope,
                    kind: parentFrame ? 'iframe' : 'document',
                    parentScopeId,
                    hostCaptureId,
                    transformToParent: frameTransform,
                });
            } else {
                scopes.push(rawScope);
            }
        }
    }

    if (capturedFrames.length === 0) {
        diagnostics.push(captureDiagnostic(
            'capture.page.no-frames',
            'page exposed no frames to the capture pipeline',
        ));
    }

    return {
        scopes,
        nodes,
        domStatus: unavailableCount === 0 ? 'complete' : nodes.length > 0 ? 'partial' : 'unavailable',
        geometryStatus: nodes.length === 0
            ? 'unavailable'
            : nodeWithoutGeometryCount === 0 ? 'complete' : 'partial',
    };
};

const deriveFrameTransform = (
    capturedFrame: CapturedFrame,
    capturedFrames: readonly CapturedFrame[],
    parentFrame: Frame,
): RectTransform | undefined => {
    const hostCaptureId = capturedFrame.hostCaptureId;
    if (!hostCaptureId) {return undefined;}
    const parentPayload = capturedFrames.find((captured) => captured.frame === parentFrame)?.payload;
    const childPayload = capturedFrame.payload;
    const hostNode = parentPayload?.nodes.find((node) => node.captureId === hostCaptureId);
    if (!hostNode?.geometry || !childPayload) {return undefined;}

    const metrics = hostNode.frameMetrics;
    const contentX = metrics?.contentX ?? hostNode.geometry.x;
    const contentY = metrics?.contentY ?? hostNode.geometry.y;
    const contentWidth = metrics?.contentWidth ?? hostNode.geometry.width;
    const contentHeight = metrics?.contentHeight ?? hostNode.geometry.height;
    const viewportWidth = childPayload.viewport.width;
    const viewportHeight = childPayload.viewport.height;

    return {
        scaleX: viewportWidth > 0 ? contentWidth / viewportWidth : 1,
        scaleY: viewportHeight > 0 ? contentHeight / viewportHeight : 1,
        translateX: contentX,
        translateY: contentY,
    };
};

const captureBackendNodeIds = async (
    page: Page,
    diagnostics: AnalysisDiagnostic[],
): Promise<Map<string, string>> => {
    const cdp = await page.context().newCDPSession(page);
    try {
        const raw = await cdp.send('DOMSnapshot.captureSnapshot', {
            computedStyles: [],
            includeDOMRects: false,
            includePaintOrder: false,
        }) as DomSnapshotCaptureResult;
        return decodeBackendNodeIds(raw);
    } catch (error) {
        diagnostics.push(captureDiagnostic(
            'capture.dom-snapshot.failed',
            'CDP DOMSnapshot capture failed',
            error,
        ));
        return new Map();
    } finally {
        await cdp.detach().catch(() => undefined);
    }
};

const decodeBackendNodeIds = (raw: DomSnapshotCaptureResult): Map<string, string> => {
    const result = new Map<string, string>();
    const strings = raw.strings ?? [];
    for (const document of raw.documents ?? []) {
        const backendNodeIds = document.nodes?.backendNodeId ?? [];
        const attributes = document.nodes?.attributes ?? [];
        const limit = Math.min(backendNodeIds.length, attributes.length);
        for (let nodeIndex = 0; nodeIndex < limit; nodeIndex += 1) {
            const rawAttributes = attributes[nodeIndex];
            if (!Array.isArray(rawAttributes)) {continue;}
            const marker = readSnapshotAttribute(rawAttributes, strings, OBSERVATION_MARKER_ATTRIBUTE);
            const backendNodeId = backendNodeIds[nodeIndex];
            if (!marker || typeof backendNodeId !== 'number' || backendNodeId <= 0) {continue;}
            result.set(marker, String(backendNodeId));
        }
    }
    return result;
};

const readSnapshotAttribute = (
    rawAttributes: readonly number[],
    strings: readonly string[],
    targetName: string,
): string | undefined => {
    for (let index = 0; index + 1 < rawAttributes.length; index += 2) {
        const name = strings[rawAttributes[index] ?? -1] ?? '';
        if (name !== targetName) {continue;}
        return strings[rawAttributes[index + 1] ?? -1] ?? undefined;
    }
    return undefined;
};

const captureAccessibility = async (
    page: Page,
    diagnostics: AnalysisDiagnostic[],
): Promise<{ records: AccessibilityRecord[]; status: RawPageCapture['completeness']['a11y'] }> => {
    const cdp = await page.context().newCDPSession(page);
    try {
        await cdp.send('Accessibility.enable');
        const result = await cdp.send('Accessibility.getFullAXTree') as {
            nodes?: CdpAccessibilityNode[];
        };
        return {
            records: (result.nodes ?? []).map(toAccessibilityRecord),
            status: 'complete',
        };
    } catch (error) {
        diagnostics.push(captureDiagnostic(
            'capture.accessibility.failed',
            'CDP accessibility capture failed',
            error,
        ));
        return { records: [], status: 'unavailable' };
    } finally {
        await cdp.detach().catch(() => undefined);
    }
};

const toAccessibilityRecord = (node: CdpAccessibilityNode): AccessibilityRecord => {
    const properties = new Map(
        (node.properties ?? [])
            .filter((property) => property.name)
            .map((property) => [property.name as string, normalizeUnknown(property.value?.value)] as const),
    );
    return {
        axNodeId: node.nodeId,
        backendNodeId: typeof node.backendDOMNodeId === 'number'
            ? String(node.backendDOMNodeId)
            : undefined,
        role: normalizeUnknown(node.role?.value),
        name: normalizeUnknown(node.name?.value),
        description: normalizeUnknown(node.description?.value),
        value: normalizeUnknown(node.value?.value),
        checked: properties.get('checked'),
        selected: properties.get('selected'),
        expanded: properties.get('expanded'),
        pressed: properties.get('pressed'),
        disabled: properties.get('disabled'),
        readonly: properties.get('readonly'),
        invalid: properties.get('invalid'),
        focused: properties.get('focused'),
    };
};

const restoreObservationMarkers = async (
    capturedFrames: readonly CapturedFrame[],
): Promise<void> => {
    for (const captured of capturedFrames) {
        if (!captured.payload) {continue;}
        await captured.frame.evaluate(
            ({ script, input }) => {
                const restore = (0, eval)(script) as (value: unknown) => unknown;
                return restore(input);
            },
            {
                script: RESTORE_MARKERS_SCRIPT,
                input: {
                    markerAttribute: OBSERVATION_MARKER_ATTRIBUTE,
                    restorations: captured.payload.restorations,
                },
            },
        ).catch(() => undefined);
    }
};

const captureDiagnostic = (
    code: string,
    message: string,
    error?: unknown,
): AnalysisDiagnostic => ({
    code,
    severity: 'warning',
    stage: 'capture',
    status: 'partial',
    nodeIds: [],
    evidence: [],
    message: error ? `${message}: ${errorMessage(error)}` : message,
});

const errorMessage = (error: unknown): string => {
    if (error instanceof Error) {return error.message;}
    return unknownText(error, 'unknown error');
};

const unknownText = (value: unknown, fallback: string): string => {
    if (value === undefined) {return fallback;}
    if (value === null) {return 'null';}
    if (typeof value === 'string') {return value;}
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return `${value}`;
    }
    if (typeof value === 'symbol') {return value.description ?? fallback;}
    try {
        return JSON.stringify(value) ?? fallback;
    } catch {
        return Object.prototype.toString.call(value);
    }
};

const normalizeUnknown = (value: unknown): string | undefined => {
    if (value === undefined || value === null) {return undefined;}
    const normalized = unknownText(value, '').trim();
    return normalized || undefined;
};

const FRAME_CAPTURE_SCRIPT = `(input) => {
    const markerAttribute = input.markerAttribute;
    const stateAttribute = input.stateAttribute;
    const frameIndex = input.frameIndex;
    const documentScopeId = input.documentScopeId;
    const captureRunId = input.captureRunId;
    const nodes = [];
    const scopes = [];
    const restorations = [];
    let markerSequence = 0;
    let shadowSequence = 0;

    const normalize = (value) => (value == null ? '' : String(value)).replace(/\\s+/g, ' ').trim();
    const ignoredTags = new Set(['script', 'style']);
    const isIgnored = (element) => {
        const tag = normalize(element.tagName).toLowerCase();
        if (!tag || ignoredTags.has(tag)) return true;
        const ignoreMarker = normalize(element.getAttribute('data-rpa-snapshot-ignore')).toLowerCase();
        if (ignoreMarker === '1' || ignoreMarker === 'true' || ignoreMarker === 'yes') return true;
        return normalize(element.id).toLowerCase() === 'rpa-floating-panel';
    };
    const composedParent = (element) => {
        if (element.parentElement) return element.parentElement;
        const root = typeof element.getRootNode === 'function' ? element.getRootNode() : null;
        return root && root.host && root.host.nodeType === 1 ? root.host : null;
    };
    const hasBlockedAncestor = (element, predicate) => {
        let cursor = element;
        while (cursor) {
            if (predicate(cursor)) return true;
            cursor = composedParent(cursor);
        }
        return false;
    };
    const ensureMarker = (element) => {
        const previousValue = element.hasAttribute(markerAttribute)
            ? element.getAttribute(markerAttribute)
            : undefined;
        markerSequence += 1;
        const marker = captureRunId + ':frame:' + frameIndex + ':node:' + markerSequence;
        element.setAttribute(markerAttribute, marker);
        restorations.push({ marker, previousValue: previousValue == null ? undefined : previousValue });
        return marker;
    };
    const readAttributes = (element) => {
        const attributes = {};
        for (const attribute of Array.from(element.attributes)) {
            const name = attribute.name.toLowerCase();
            if (name === markerAttribute || name === stateAttribute) continue;
            attributes[name] = attribute.value;
        }
        return attributes;
    };
    const readOwnText = (element) => {
        const chunks = [];
        for (const child of Array.from(element.childNodes)) {
            if (child.nodeType !== Node.TEXT_NODE) continue;
            const text = normalize(child.textContent);
            if (text) chunks.push(text);
        }
        const merged = normalize(chunks.join(' '));
        return merged || undefined;
    };
    const readGeometry = (element) => {
        const rect = element.getBoundingClientRect();
        if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return undefined;
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const readActivity = (element) => {
        const style = getComputedStyle(element);
        const hiddenByStyle = hasBlockedAncestor(element, (candidate) => {
            const candidateStyle = getComputedStyle(candidate);
            return candidateStyle.display === 'none'
                || candidateStyle.visibility === 'hidden'
                || candidateStyle.visibility === 'collapse'
                || candidateStyle.contentVisibility === 'hidden';
        });
        const inert = hasBlockedAncestor(element, (candidate) =>
            candidate.hasAttribute('inert') || candidate.inert === true);
        const ariaExposed = !hasBlockedAncestor(element, (candidate) =>
            normalize(candidate.getAttribute('aria-hidden')).toLowerCase() === 'true');
        const rects = element.getClientRects();
        let selfHasBox = false;
        for (const rect of Array.from(rects)) {
            if (rect.width > 0 && rect.height > 0) {
                selfHasBox = true;
                break;
            }
        }
        return {
            hiddenByStyle,
            inert,
            ariaExposed,
            selfHasBox,
            rendered: !hiddenByStyle && style.display !== 'none',
        };
    };
    const readFrameMetrics = (element, geometry) => {
        if (normalize(element.tagName).toLowerCase() !== 'iframe' || !geometry) return undefined;
        const borderWidth = Number(element.offsetWidth) || geometry.width;
        const borderHeight = Number(element.offsetHeight) || geometry.height;
        const scaleX = borderWidth > 0 ? geometry.width / borderWidth : 1;
        const scaleY = borderHeight > 0 ? geometry.height / borderHeight : 1;
        return {
            contentX: geometry.x + (Number(element.clientLeft) || 0) * scaleX,
            contentY: geometry.y + (Number(element.clientTop) || 0) * scaleY,
            contentWidth: (Number(element.clientWidth) || borderWidth) * scaleX,
            contentHeight: (Number(element.clientHeight) || borderHeight) * scaleY,
        };
    };

    const captureRoot = (rootLike, scopeId, rootElement, syntheticRoot) => {
        const captureElement = (element, parentCaptureId) => {
            if (isIgnored(element)) return null;
            const captureId = ensureMarker(element);
            const geometry = readGeometry(element);
            const node = {
                captureId,
                scopeId,
                parentCaptureId,
                childCaptureIds: [],
                tag: normalize(element.tagName).toLowerCase(),
                attributes: readAttributes(element),
                ownText: readOwnText(element),
                runtimeStateToken: normalize(element.getAttribute(stateAttribute)) || undefined,
                geometry,
                geometrySource: 'live-dom',
                activity: readActivity(element),
                frameMetrics: readFrameMetrics(element, geometry),
            };
            nodes.push(node);
            for (const child of Array.from(element.children)) {
                const childCaptureId = captureElement(child, captureId);
                if (childCaptureId) node.childCaptureIds.push(childCaptureId);
            }
            if (element.shadowRoot && element.shadowRoot.mode === 'open') {
                captureShadowRoot(element.shadowRoot, captureId, scopeId, node.activity, geometry);
            }
            return captureId;
        };

        if (syntheticRoot) {
            const syntheticCaptureId = syntheticRoot.captureId;
            const syntheticNode = {
                captureId: syntheticCaptureId,
                scopeId,
                childCaptureIds: [],
                tag: '#shadow-root',
                attributes: {},
                geometry: syntheticRoot.geometry,
                geometrySource: 'live-dom',
                activity: {
                    hiddenByStyle: syntheticRoot.activity.hiddenByStyle,
                    inert: syntheticRoot.activity.inert,
                    ariaExposed: syntheticRoot.activity.ariaExposed,
                    selfHasBox: false,
                    rendered: syntheticRoot.activity.rendered,
                },
            };
            nodes.push(syntheticNode);
            for (const child of Array.from(rootLike.children || [])) {
                const childCaptureId = captureElement(child, syntheticCaptureId);
                if (childCaptureId) syntheticNode.childCaptureIds.push(childCaptureId);
            }
            return syntheticCaptureId;
        }
        return captureElement(rootElement, undefined);
    };

    const captureShadowRoot = (shadowRoot, hostCaptureId, parentScopeId, hostActivity, hostGeometry) => {
        shadowSequence += 1;
        const scopeId = documentScopeId + ':shadow:' + shadowSequence;
        const rootCaptureId = captureRunId + ':frame:' + frameIndex + ':shadow-root:' + shadowSequence;
        captureRoot(shadowRoot, scopeId, null, {
            captureId: rootCaptureId,
            activity: hostActivity,
            geometry: hostGeometry,
        });
        scopes.push({
            id: scopeId,
            kind: 'open-shadow-root',
            parentScopeId,
            hostCaptureId,
            rootCaptureId,
            status: 'captured',
            transformToParent: {
                scaleX: 1,
                scaleY: 1,
                translateX: 0,
                translateY: 0,
            },
            viewport: {
                width: globalThis.innerWidth || 0,
                height: globalThis.innerHeight || 0,
            },
        });
    };

    const documentRoot = document.documentElement;
    const rootCaptureId = documentRoot
        ? captureRoot(document, documentScopeId, documentRoot, null)
        : captureRunId + ':frame:' + frameIndex + ':missing-document-root';
    if (!documentRoot) {
        nodes.push({
            captureId: rootCaptureId,
            scopeId: documentScopeId,
            childCaptureIds: [],
            tag: '#missing-document-root',
            attributes: {},
            activity: {
                hiddenByStyle: true,
                inert: false,
                selfHasBox: false,
                rendered: false,
            },
        });
    }
    scopes.unshift({
        id: documentScopeId,
        kind: 'document',
        rootCaptureId,
        status: 'captured',
        viewport: {
            width: globalThis.innerWidth || 0,
            height: globalThis.innerHeight || 0,
        },
    });
    return {
        nodes,
        scopes,
        restorations,
        viewport: {
            width: globalThis.innerWidth || 0,
            height: globalThis.innerHeight || 0,
        },
    };
}`;

const RESTORE_MARKERS_SCRIPT = `(input) => {
    const markerAttribute = input.markerAttribute;
    const restorationByMarker = new Map(
        input.restorations.map((item) => [item.marker, item.previousValue]),
    );
    const visitRoot = (rootLike) => {
        const elements = Array.from(rootLike.querySelectorAll('*'));
        for (const element of elements) {
            const marker = element.getAttribute(markerAttribute);
            if (marker && restorationByMarker.has(marker)) {
                const previousValue = restorationByMarker.get(marker);
                if (previousValue === undefined) {
                    element.removeAttribute(markerAttribute);
                } else {
                    element.setAttribute(markerAttribute, previousValue);
                }
            }
            if (element.shadowRoot && element.shadowRoot.mode === 'open') {
                visitRoot(element.shadowRoot);
            }
        }
    };
    visitRoot(document);
    return true;
}`;
