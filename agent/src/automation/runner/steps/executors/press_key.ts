import type { Step, StepResult } from '../types';
import type { RunStepsDeps, RunStepsExecutionContext } from '../../run_steps_types';
import { recordedActionTarget } from '../helpers/recorded_action_target';
import { awaitPageBoundBinding } from '../helpers/runtime_binding';
import { pickDelayMs, waitForHumanDelay } from '../helpers/delay';
import { executeAtomicPressKey } from '../../../snapshot';

export const executeBrowserPressKey = async (
    step: Step<'browser.press_key'>,
    deps: RunStepsDeps,
    workspaceName: string,
    context?: RunStepsExecutionContext,
): Promise<StepResult> => {
    const binding = await awaitPageBoundBinding(deps, workspaceName);
    const target = recordedActionTarget(step, step.resolve?.hint?.raw?.framePath !== undefined
        || step.resolve?.hint?.locator?.scope?.kind === 'iframe' ? context : undefined);
    const hasTarget = Boolean(target.nodeId || target.selector || target.framePath !== undefined);
    const result = await executeAtomicPressKey(
        binding.page,
        hasTarget ? target : undefined,
        normalizeBrowserPressKey(step.args.key),
        { timeoutMs: deps.config.waitPolicy.visibleTimeoutMs },
    );
    if (!result.ok) {
        return { stepId: step.id, ok: false, error: { code: result.code, message: result.message, details: result.details } };
    }
    if (deps.config.humanPolicy.enabled) {
        const delayMs = pickDelayMs(
            deps.config.humanPolicy.typeDelayMsRange.min,
            deps.config.humanPolicy.typeDelayMsRange.max,
        );
        if (delayMs > 0) {await waitForHumanDelay(binding.page, delayMs);}
    }
    return {
        stepId: step.id,
        ok: true,
        data: {
            nodeId: result.nodeId || undefined,
            controlRef: result.controlRef,
            captureRevision: result.captureRevision || undefined,
            resolver: result.replayFallback ? 'recorded-target-fallback' : hasTarget ? 'snapshot-v2-canonical-locator' : 'page-keyboard',
        },
    };
};

export const normalizeBrowserPressKey = (rawKey: string, platform: NodeJS.Platform = process.platform): string => {
    const key = rawKey.trim();
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
