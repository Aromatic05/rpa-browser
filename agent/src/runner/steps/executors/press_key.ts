import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { normalizeTarget, mapTraceError } from '../helpers/target';
import { pickDelayMs, waitForHumanDelay } from '../helpers/delay';
import { resolveTargetNodeId, type ResolvedLocatorTarget } from '../helpers/resolve_target';

const ensureVisible = async (
    binding: Awaited<ReturnType<RunStepsDeps['runtime']['ensureActivePage']>>,
    target: ResolvedLocatorTarget,
    timeout?: number,
) => {
    const scroll = await binding.traceTools['trace.locator.scrollIntoView']({
        a11yNodeId: target.a11yNodeId,
        selector: target.selector,
        role: target.role,
        name: target.name,
    });
    if (!scroll.ok) return scroll;
    return binding.traceTools['trace.locator.waitForVisible']({
        a11yNodeId: target.a11yNodeId,
        selector: target.selector,
        role: target.role,
        name: target.name,
        timeout,
    });
};

export const executeBrowserPressKey = async (
    step: Step<'browser.press_key'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const target = normalizeTarget(step.args);
    if (target) {
        const resolved = await resolveTargetNodeId(binding, target);
        if (!resolved.ok) return { stepId: step.id, ok: false, error: resolved.error };
        const timeout = step.args.timeout ?? deps.config.waitPolicy.visibleTimeoutMs;
        const visible = await ensureVisible(binding, resolved.target, timeout);
        if (!visible.ok) {
            return { stepId: step.id, ok: false, error: mapTraceError(visible.error) };
        }
        const focus = await binding.traceTools['trace.locator.focus']({
            a11yNodeId: resolved.target.a11yNodeId,
            selector: resolved.target.selector,
            role: resolved.target.role,
            name: resolved.target.name,
        });
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
        if (delayMs > 0) await waitForHumanDelay(binding.page, delayMs);
    }
    return { stepId: step.id, ok: true };
};

export const normalizeBrowserPressKey = (rawKey: string, platform: NodeJS.Platform = process.platform): string => {
    const key = String(rawKey || '').trim();
    if (!key) return key;

    const normalized = key
        .split('+')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .map((part) => {
            const lower = part.toLowerCase();
            if (lower === 'ctrl') return 'Control';
            if (lower === 'cmdorctrl') return platform === 'darwin' ? 'Meta' : 'Control';
            if (lower === 'cmd' || lower === 'command') return 'Meta';
            if (lower === 'esc') return 'Escape';
            return part.length === 1 ? part.toUpperCase() : part;
        });

    // On macOS, Control+<key> usually does not represent "primary shortcut".
    // Map to Meta+<key> for common automation expectations (e.g. select-all).
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
