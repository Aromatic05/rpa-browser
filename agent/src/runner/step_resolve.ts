import type { StepName, StepResolve, StepResult, StepUnion } from './steps/types';
import { isValidStepResolve } from './steps/resolve_utils';

const STEP_RESOLVE_STEP_NAMES: ReadonlySet<StepName> = new Set<StepName>([
    'browser.take_screenshot', 'browser.click', 'browser.fill', 'browser.type',
    'browser.select_option', 'browser.hover', 'browser.scroll', 'browser.press_key', 'browser.drag_and_drop',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

export const injectStepResolve = (
    step: StepUnion,
    stepResolves?: Record<string, StepResolve>,
): { ok: true; step: StepUnion } | { ok: false; error: StepResult['error'] } => {
    const argsRecord: unknown = step.args;
    const resolveId = isRecord(argsRecord) && typeof argsRecord.resolveId === 'string' ? argsRecord.resolveId : undefined;
    if (!resolveId) {
        if (!step.resolve || isValidStepResolve(step.resolve)) {return {ok: true, step};}
        return {ok: false, error: {code: 'ERR_BAD_ARGS', message: `step ${step.id} has invalid resolve`, details: {stepId: step.id, reason: 'empty_resolve_hint'}}};
    }
    if (step.resolve) {return {ok: false, error: {code: 'ERR_BAD_ARGS', message: `step ${step.id} cannot use resolve and resolveId together`}};}
    if (!STEP_RESOLVE_STEP_NAMES.has(step.name)) {
        return {ok: false, error: {code: 'ERR_BAD_ARGS', message: `step ${step.id} does not support resolveId`, details: {stepName: step.name, resolveId}}};
    }
    if (!stepResolves || !Object.hasOwn(stepResolves, resolveId)) {
        return {ok: false, error: {code: 'ERR_BAD_ARGS', message: `step resolve not found: ${resolveId}`, details: {stepId: step.id, resolveId}}};
    }
    const resolve = stepResolves[resolveId];
    if (!isValidStepResolve(resolve)) {
        return {ok: false, error: {code: 'ERR_BAD_ARGS', message: `step resolve is invalid: ${resolveId}`, details: {stepId: step.id, resolveId, reason: 'empty_resolve_hint'}}};
    }
    const {resolveId: _resolveId, ...args} = argsRecord as Record<string, unknown>;
    return {ok: true, step: {...step, args, resolve} as StepUnion};
};
