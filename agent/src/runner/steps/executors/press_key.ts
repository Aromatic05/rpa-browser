import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { mapTraceError } from '../helpers/target';
import { pickDelayMs, waitForHumanDelay } from '../helpers/delay';
import { resolveTarget } from '../helpers/resolve_target';

export const executeBrowserPressKey = async (
    step: Step<'browser.press_key'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const hasTarget = Boolean(step.args.nodeId || step.args.selector || step.args.resolveId || step.resolve);
    if (hasTarget) {
        const resolved = await resolveTarget(binding, {
            nodeId: step.args.nodeId,
            selector: step.args.selector,
            resolve: step.resolve,
        });
        if (!resolved.ok) {return { stepId: step.id, ok: false, error: resolved.error };}

        const timeout = step.args.timeout ?? deps.config.waitPolicy.visibleTimeoutMs;
        const scroll = await binding.traceTools['trace.locator.scrollIntoView']({ selector: resolved.target.selector });
        if (!scroll.ok) {return { stepId: step.id, ok: false, error: mapTraceError(scroll.error) };}
        const visible = await binding.traceTools['trace.locator.waitForVisible']({
            selector: resolved.target.selector,
            timeout,
        });
        if (!visible.ok) {
            return { stepId: step.id, ok: false, error: mapTraceError(visible.error) };
        }
        const focus = await binding.traceTools['trace.locator.focus']({ selector: resolved.target.selector });
        if (!focus.ok) {
            return { stepId: step.id, ok: false, error: mapTraceError(focus.error) };
        }
    }

    const pressed = await binding.traceTools['trace.keyboard.press']({
        key: normalizeBrowserPressKey(step.args.key),
    });
    if (!pressed.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(pressed.error) };
    }
    if (deps.config.humanPolicy.enabled) {
        const delayMs = pickDelayMs(
            deps.config.humanPolicy.typeDelayMsRange.min,
            deps.config.humanPolicy.typeDelayMsRange.max,
        );
        if (delayMs > 0) {await waitForHumanDelay(binding.page, delayMs);}
    }
    return { stepId: step.id, ok: true };
};

export const normalizeBrowserPressKey = (rawKey: string, platform: NodeJS.Platform = process.platform): string => {
    const key = String(rawKey || '').trim();
    if (!key) {return key;}

    const normalized = key
        .split('+')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .map((part) => {
            const lower = part.toLowerCase();
            if (lower === 'ctrl') {return 'Control';}
            if (lower === 'cmdorctrl') {return platform === 'darwin' ? 'Meta' : 'Control';}
            if (lower === 'cmd' || lower === 'command') {return 'Meta';}
            if (lower === 'esc') {return 'Escape';}
            return part.length === 1 ? part.toUpperCase() : part;
        });

    if (platform === 'darwin') {
        const hasMeta = normalized.some((part) => part.toLowerCase() === 'meta');
        const hasControl = normalized.some((part) => part.toLowerCase() === 'control');
        const hasNonModifier = normalized.some((part) => !MODIFIER_KEYS.has(part.toLowerCase()));
        if (!hasMeta && hasControl && hasNonModifier) {
            return normalized.map((part) => (part.toLowerCase() === 'control' ? 'Meta' : part)).join('+');
        }
    }
    return normalized.join('+');
};

const MODIFIER_KEYS = new Set(['shift', 'control', 'meta', 'alt', 'altgraph']);
