import { randomUUID } from 'node:crypto';
import type { ElementHandle, Page } from 'playwright';
import { captureControlSnapshot } from '../capture/browser';
import type { AtomicActionErrorCode, ControlSnapshot } from '../model/contracts';

const TARGET_ATTRIBUTE = 'data-rpa-action-target';

type SelectorCaptureResult =
    | { ok: true; snapshot: ControlSnapshot; nodeId: string }
    | { ok: false; code: AtomicActionErrorCode; message: string; details?: Record<string, unknown> };

export const captureSelectorTarget = async (
    page: Page,
    selector: string,
): Promise<SelectorCaptureResult> => {
    let handle: ElementHandle<HTMLElement | SVGElement>;
    try {
        const locator = page.locator(selector);
        const count = await locator.count();
        if (count === 0) {return failure('ERR_NOT_FOUND', 'selector did not match a node', { selector });}
        if (count > 1) {return failure('ERR_AMBIGUOUS', 'selector matched multiple nodes', { selector, count });}
        const candidate = await locator.elementHandle();
        if (!candidate) {return failure('ERR_STALE', 'selector target disappeared before capture', { selector });}
        handle = candidate;
    } catch (error) {
        return failure('ERR_BAD_ARGS', 'selector is invalid', {
            selector,
            error: error instanceof Error ? error.message : String(error),
        });
    }

    const token = randomUUID();
    const previous = await handle.evaluate((node, input) => {
        const value = node.getAttribute(input.attribute);
        node.setAttribute(input.attribute, input.token);
        return { hadAttribute: value !== null, value };
    }, { attribute: TARGET_ATTRIBUTE, token });
    try {
        const snapshot = await captureControlSnapshot(page);
        const nodeIds = Object.keys(snapshot.observation.nodes).filter((nodeId) =>
            snapshot.observation.attributes[nodeId]?.[TARGET_ATTRIBUTE] === token);
        if (nodeIds.length !== 1) {
            return failure(
                nodeIds.length > 1 ? 'ERR_AMBIGUOUS' : 'ERR_UNRESOLVED',
                'selector target did not map to exactly one canonical node',
                { selector, nodeIds },
            );
        }
        return { ok: true, snapshot, nodeId: nodeIds[0] };
    } finally {
        await handle.evaluate((node, input) => {
            if (node.getAttribute(input.attribute) !== input.token) {return;}
            if (input.hadAttribute) {node.setAttribute(input.attribute, input.value ?? '');}
            else {node.removeAttribute(input.attribute);}
        }, { attribute: TARGET_ATTRIBUTE, token, ...previous }).catch(() => undefined);
        await handle.dispose().catch(() => undefined);
    }
};

const failure = (
    code: AtomicActionErrorCode,
    message: string,
    details?: Record<string, unknown>,
): SelectorCaptureResult => ({ ok: false, code, message, details });
