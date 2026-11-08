import { randomUUID } from 'node:crypto';
import type { ElementHandle, Locator, Page } from 'playwright';
import { captureControlSnapshot } from '../capture/browser';
import type { AtomicActionErrorCode, ControlSnapshot } from '../model/contracts';

const TARGET_ATTRIBUTE = 'data-rpa-action-target';

type SelectorCaptureResult =
    | { ok: true; snapshot: ControlSnapshot; nodeId: string }
    | { ok: false; code: AtomicActionErrorCode; message: string; details?: Record<string, unknown> };

export const captureSelectorTarget = async (
    page: Page,
    selector: string,
): Promise<SelectorCaptureResult> => await captureLocatorTarget(page, page.locator(selector), {selector});

export const captureLocatorTarget = async (
    page: Page,
    locator: Locator,
    details: Record<string, unknown>,
    requireVisible = false,
): Promise<SelectorCaptureResult> => {
    let handle: ElementHandle;
    try {
        const count = await locator.count();
        if (count === 0) {return failure('ERR_NOT_FOUND', 'selector did not match a node', details);}
        if (count > 1) {return failure('ERR_AMBIGUOUS', 'selector matched multiple nodes', {...details, count});}
        const matches = await locator.elementHandles();
        if (matches.length === 0) {return failure('ERR_STALE', 'selector target disappeared before capture', details);}
        if (matches.length > 1) {
            await Promise.allSettled(matches.map((match) => match.dispose()));
            return failure('ERR_AMBIGUOUS', 'selector matched multiple nodes', {...details, count: matches.length});
        }
        handle = matches[0];
    } catch (error) {
        return failure('ERR_BAD_ARGS', 'selector is invalid', {
            ...details,
            error: error instanceof Error ? error.message : String(error),
        });
    }

    const token = randomUUID();
    let previous: {hadAttribute: boolean; value: string | null} | undefined;
    try {
        if (requireVisible && !await handle.isVisible()) {
            return failure('ERR_UNRESOLVED', 'recorded fallback target is not visible', details);
        }
        previous = await handle.evaluate((node, input) => {
            if (!(node instanceof Element) || !node.isConnected) {return undefined;}
            const value = node.getAttribute(input.attribute);
            node.setAttribute(input.attribute, input.token);
            return { hadAttribute: value !== null, value };
        }, { attribute: TARGET_ATTRIBUTE, token });
        if (!previous) {return failure('ERR_STALE', 'selector target disappeared before capture', details);}
        const snapshot = await captureControlSnapshot(page);
        const nodeIds = Object.keys(snapshot.observation.nodes).filter((nodeId) =>
            snapshot.observation.attributes[nodeId][TARGET_ATTRIBUTE] === token);
        if (nodeIds.length !== 1) {
            return failure(
                nodeIds.length > 1 ? 'ERR_AMBIGUOUS' : 'ERR_UNRESOLVED',
                'selector target did not map to exactly one canonical node',
                { ...details, nodeIds },
            );
        }
        return { ok: true, snapshot, nodeId: nodeIds[0] };
    } finally {
        if (previous) {
            await handle.evaluate((node, input) => {
                if (!(node instanceof Element) || node.getAttribute(input.attribute) !== input.token) {return;}
                if (input.hadAttribute) {node.setAttribute(input.attribute, input.value ?? '');}
                else {node.removeAttribute(input.attribute);}
            }, { attribute: TARGET_ATTRIBUTE, token, ...previous }).catch(() => undefined);
        }
        await handle.dispose().catch(() => undefined);
    }
};

const failure = (
    code: AtomicActionErrorCode,
    message: string,
    details?: Record<string, unknown>,
): SelectorCaptureResult => ({ ok: false, code, message, details });
