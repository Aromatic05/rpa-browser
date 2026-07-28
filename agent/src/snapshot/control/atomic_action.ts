import type { Locator, Page } from 'playwright';
import { resolveAtomicActionTarget } from './action_target';
import type { AtomicActionFailure, AtomicActionResult } from './contracts';

export type AtomicTargetInput = {
    nodeId?: string;
    selector?: string;
};

export const executeAtomicClick = async (
    page: Page,
    target: AtomicTargetInput,
    options: {
        timeoutMs?: number;
        button?: 'left' | 'right' | 'middle';
        double?: boolean;
    } = {},
): Promise<AtomicActionResult> => {
    const resolved = await resolveAtomicActionTarget(page, {
        ...target,
        requiredCapabilities: ['click', 'open_popup'],
    });
    if (!resolved.ok) {return resolved.error;}
    return await runAction(resolved.target.locator, resolved.target, async (locator) => {
        await locator.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
        await locator.waitFor({ state: 'visible', timeout: options.timeoutMs });
        await locator.click({
            timeout: options.timeoutMs,
            button: options.button,
            clickCount: options.double ? 2 : 1,
        });
    });
};

export const executeAtomicFill = async (
    page: Page,
    target: AtomicTargetInput,
    value: string,
    options: { timeoutMs?: number } = {},
): Promise<AtomicActionResult> => {
    const resolved = await resolveAtomicActionTarget(page, {
        ...target,
        requiredCapabilities: ['fill'],
    });
    if (!resolved.ok) {return resolved.error;}
    return await runAction(resolved.target.locator, resolved.target, async (locator) => {
        await locator.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
        await locator.waitFor({ state: 'visible', timeout: options.timeoutMs });
        await locator.fill(value, { timeout: options.timeoutMs });
        const actual = await readEditableValue(locator);
        if (actual !== value) {
            throw assertionError('filled value does not match after action', { expected: value, actual });
        }
    });
};

export const executeAtomicType = async (
    page: Page,
    target: AtomicTargetInput,
    text: string,
    options: { timeoutMs?: number; delayMs?: number } = {},
): Promise<AtomicActionResult> => {
    const resolved = await resolveAtomicActionTarget(page, {
        ...target,
        requiredCapabilities: ['fill'],
    });
    if (!resolved.ok) {return resolved.error;}
    return await runAction(resolved.target.locator, resolved.target, async (locator) => {
        await locator.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
        await locator.waitFor({ state: 'visible', timeout: options.timeoutMs });
        await locator.focus({ timeout: options.timeoutMs });
        await locator.pressSequentially(text, { delay: options.delayMs, timeout: options.timeoutMs });
    });
};

export const executeAtomicHover = async (
    page: Page,
    target: AtomicTargetInput,
    options: { timeoutMs?: number } = {},
): Promise<AtomicActionResult> => {
    const resolved = await resolveAtomicActionTarget(page, target);
    if (!resolved.ok) {return resolved.error;}
    return await runAction(resolved.target.locator, resolved.target, async (locator) => {
        await locator.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
        await locator.waitFor({ state: 'visible', timeout: options.timeoutMs });
        await locator.hover({ timeout: options.timeoutMs });
    });
};

export const executeAtomicPressKey = async (
    page: Page,
    target: AtomicTargetInput | undefined,
    key: string,
    options: { timeoutMs?: number } = {},
): Promise<AtomicActionResult> => {
    if (!key.trim()) {
        return failure('ERR_BAD_ARGS', 'key must be non-empty');
    }
    if (!target?.nodeId && !target?.selector) {
        try {
            await page.keyboard.press(key);
            return { ok: true, nodeId: '', captureRevision: 0 };
        } catch (error) {
            return fromError(error);
        }
    }
    const resolved = await resolveAtomicActionTarget(page, {
        ...target,
        requiredCapabilities: ['focus'],
    });
    if (!resolved.ok) {return resolved.error;}
    return await runAction(resolved.target.locator, resolved.target, async (locator) => {
        await locator.scrollIntoViewIfNeeded({ timeout: options.timeoutMs });
        await locator.waitFor({ state: 'visible', timeout: options.timeoutMs });
        await locator.focus({ timeout: options.timeoutMs });
        await page.keyboard.press(key);
    });
};

const runAction = async (
    locator: Locator,
    target: {
        nodeId: string;
        snapshot: { observation: { identity: { captureRevision: number } } };
        control?: { ref: string };
    },
    action: (locator: Locator) => Promise<void>,
): Promise<AtomicActionResult> => {
    try {
        await action(locator);
        return {
            ok: true,
            nodeId: target.nodeId,
            controlRef: target.control?.ref,
            captureRevision: target.snapshot.observation.identity.captureRevision,
        };
    } catch (error) {
        return fromError(error);
    }
};

const readEditableValue = async (locator: Locator): Promise<string> => await locator.evaluate((node) => {
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) {
        return node.value;
    }
    if (node instanceof HTMLElement && node.isContentEditable) {return node.textContent ?? '';}
    return '';
});

const assertionError = (message: string, details: Record<string, unknown>): Error & { actionDetails: Record<string, unknown> } => {
    const error = new Error(message) as Error & { actionDetails: Record<string, unknown> };
    error.name = 'AtomicActionAssertionError';
    error.actionDetails = details;
    return error;
};

const fromError = (error: unknown): AtomicActionFailure => {
    if (error instanceof Error && error.name === 'AtomicActionAssertionError') {
        const details = (error as Error & { actionDetails?: Record<string, unknown> }).actionDetails;
        return failure('ERR_ASSERTION_FAILED', error.message, details);
    }
    const message = error instanceof Error ? error.message : String(error);
    return failure(
        /timeout/i.test(message) ? 'ERR_TIMEOUT' : 'ERR_INTERNAL',
        message,
    );
};

const failure = (
    code: AtomicActionFailure['code'],
    message: string,
    details?: Record<string, unknown>,
): AtomicActionFailure => ({ ok: false, code, message, details });
