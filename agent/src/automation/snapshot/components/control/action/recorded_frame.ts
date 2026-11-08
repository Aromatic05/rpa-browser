import type {Frame, Page} from 'playwright';
import type {PageObservation} from '../../../observation/model/contracts';

export type RecordedFramePath = ReadonlyArray<{id: string; origin: string}>;
export type RecordedFrameIssue = 'missing' | 'ambiguous' | 'changed' | 'unsupported';

const maxDepth = 8;
const usableId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_:\-.]{1,128}$/.test(id);
const isFrameIdentity = (value: unknown): value is RecordedFramePath[number] =>
    value !== null && typeof value === 'object' && 'id' in value && usableId(value.id)
    && 'origin' in value && typeof value.origin === 'string' && frameOrigin(value.origin) === value.origin;

const frameOrigin = (url: string): string | undefined => {
    if (url === 'about:blank' || url === 'about:srcdoc') {return url;}
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : undefined;
    } catch {
        return undefined;
    }
};

/** Undefined is the main document; null is a frame we could not identify safely. */
export const captureRecordedFramePath = async (frame: Frame): Promise<RecordedFramePath | null | undefined> => {
    const path: Array<RecordedFramePath[number]> = [];
    try {
        let current = frame;
        for (let parent = current.parentFrame(); parent; parent = current.parentFrame()) {
            if (path.length >= maxDepth) {return null;}
            const origin = frameOrigin(current.url());
            if (!origin) {return null;}
            const host = await current.frameElement();
            const id = await host.evaluate((node) => {
                if (!(node instanceof Element) || node.tagName !== 'IFRAME'
                    || node.getRootNode() !== node.ownerDocument || !node.id) {return null;}
                const matches = node.ownerDocument.querySelectorAll(`iframe[id="${CSS.escape(node.id)}"]`);
                return matches.length === 1 && matches[0] === node ? node.id : null;
            }).finally(async () => {await host.dispose();});
            if (!usableId(id)) {return null;}
            path.unshift({id, origin});
            current = parent;
        }
        return path.length ? path : undefined;
    } catch {
        return null;
    }
};

type FrameFailure = {
    ok: false;
    code: 'ERR_NOT_FOUND' | 'ERR_AMBIGUOUS' | 'ERR_UNRESOLVED';
    message: string;
    details: {resolution: 'recorded-frame'; frameIssue: RecordedFrameIssue};
};

export const recordedFrameFailure = (frameIssue: RecordedFrameIssue): FrameFailure => ({
    ok: false,
    code: frameIssue === 'ambiguous' ? 'ERR_AMBIGUOUS' : frameIssue === 'missing' ? 'ERR_NOT_FOUND' : 'ERR_UNRESOLVED',
    message: {
        missing: 'recorded iframe was not found',
        ambiguous: 'recorded iframe matched more than one element',
        changed: 'recorded iframe document changed',
        unsupported: 'recorded iframe cannot be identified safely',
    }[frameIssue],
    details: {resolution: 'recorded-frame', frameIssue},
});

export const resolveRecordedFrame = async (
    page: Page,
    path: RecordedFramePath | null,
): Promise<{ok: true; frame: Frame} | FrameFailure> => {
    if (!Array.isArray(path) || !path.length || path.length > maxDepth) {return recordedFrameFailure('unsupported');}
    let frame = page.mainFrame();
    const items: readonly unknown[] = path;
    for (const item of items) {
        if (!isFrameIdentity(item)) {return recordedFrameFailure('unsupported');}
        const locator = frame.locator(`css:light=iframe[id="${item.id}"]`);
        try {
            const count = await locator.count();
            if (count !== 1) {return recordedFrameFailure(count > 1 ? 'ambiguous' : 'missing');}
            const handles = await locator.elementHandles();
            let child: Frame | null;
            try {
                if (handles.length !== 1) {return recordedFrameFailure(handles.length > 1 ? 'ambiguous' : 'missing');}
                child = await handles[0].contentFrame();
            } finally {
                await Promise.allSettled(handles.map((handle) => handle.dispose()));
            }
            if (child?.parentFrame() !== frame) {return recordedFrameFailure('missing');}
            if (frameOrigin(child.url()) !== item.origin) {return recordedFrameFailure('changed');}
            frame = child;
        } catch {
            return recordedFrameFailure('missing');
        }
    }
    return {ok: true, frame};
};

export const matchesRecordedFramePath = (observation: PageObservation, nodeId: string, path: RecordedFramePath): boolean => {
    if (!Object.hasOwn(observation.nodes, nodeId)) {return false;}
    const scopes = observation.scopes.scopes;
    const readScope = (id: string) => Object.hasOwn(scopes, id) ? scopes[id] : undefined;
    let scope = readScope(observation.nodes[nodeId].scopeId);
    for (let index = path.length - 1; index >= 0; index -= 1) {
        if (scope?.kind !== 'iframe' || !scope.hostNodeId || !scope.parentScopeId
            || !Object.hasOwn(observation.attributes, scope.hostNodeId)
            || observation.attributes[scope.hostNodeId].id !== path[index].id) {return false;}
        scope = readScope(scope.parentScopeId);
    }
    return scope?.kind === 'document' && !scope.parentScopeId;
};

export const verifyRecordedFrameTarget = async (
    page: Page, frame: Frame, path: RecordedFramePath, observation: PageObservation, nodeId: string,
): Promise<FrameFailure | undefined> => {
    if (!matchesRecordedFramePath(observation, nodeId, path)) {return recordedFrameFailure('changed');}
    const current = await resolveRecordedFrame(page, path);
    if (!current.ok) {return current;}
    return current.frame === frame ? undefined : recordedFrameFailure('changed');
};
