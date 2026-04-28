import type { Step, StepResult, StepUnion } from '../steps/types';
import type { SerializedStepUnion } from '../serialization/types';
import type { Checkpoint, CheckpointAction, CheckpointProcedureOutput, CheckpointScope, CheckpointValue } from './types';

type RunCheckpointProcedureOptions = {
    checkpoint: Checkpoint;
    executeStep: (step: StepUnion) => Promise<StepResult>;
    stepIdPrefix: string;
    input?: Record<string, unknown>;
};

const REF_NOT_FOUND = 'ERR_CHECKPOINT_REF_NOT_FOUND';
const REF_INVALID = 'ERR_CHECKPOINT_REF_INVALID';
const OUTPUT_PATH_INVALID = 'ERR_CHECKPOINT_OUTPUT_PATH_INVALID';
const ACTION_UNSUPPORTED = 'ERR_CHECKPOINT_ACTION_UNSUPPORTED';

export const createCheckpointScope = (input?: Record<string, unknown>): CheckpointScope => ({
    input: { ...(input || {}) },
    local: {},
    output: {},
});

export const runCheckpointProcedure = async (options: RunCheckpointProcedureOptions): Promise<CheckpointProcedureOutput> => {
    const scope = createCheckpointScope({
        ...(options.checkpoint.input || {}),
        ...(options.input || {}),
    });

    const prepareActions = options.checkpoint.prepare || [];
    for (let i = 0; i < prepareActions.length; i += 1) {
        const action = prepareActions[i];
        const result = await executeAction(action, scope, options.executeStep, `${options.stepIdPrefix}:prepare:${i}`);
        if (!result.ok) {return result;}
    }

    const contentItems = options.checkpoint.content || [];
    for (let i = 0; i < contentItems.length; i += 1) {
        const item = contentItems[i];
        const result = await executeContentItem(item, scope, options.executeStep, `${options.stepIdPrefix}:content:${i}`);
        if (!result.ok) {return result;}
    }

    const outputResult = evaluateOutput(options.checkpoint.output, scope);
    if (!outputResult.ok) {return outputResult;}

    return {
        ok: true,
        output: outputResult.value,
        local: scope.local,
    };
};

const executeContentItem = async (
    item: SerializedStepUnion | CheckpointAction,
    scope: CheckpointScope,
    executeStep: RunCheckpointProcedureOptions['executeStep'],
    stepIdPrefix: string,
): Promise<CheckpointProcedureOutput> => {
    if (isCheckpointAction(item)) {
        return await executeAction(item, scope, executeStep, stepIdPrefix);
    }
    const result = await executeStep(item);
    if (!result.ok) {
        return {
            ok: false,
            error: result.error || { code: 'ERR_CHECKPOINT_STEP_FAILED', message: 'checkpoint content step failed' },
        };
    }
    return { ok: true };
};

const executeAction = async (
    action: CheckpointAction,
    scope: CheckpointScope,
    executeStep: RunCheckpointProcedureOptions['executeStep'],
    stepId: string,
): Promise<CheckpointProcedureOutput> => {
    if (action.type === 'wait') {
        const ms = Number(action.args?.ms || 0);
        if (!Number.isFinite(ms) || ms < 0) {
            return { ok: false, error: { code: 'ERR_BAD_ARGS', message: 'wait ms must be >= 0' } };
        }
        await delay(ms);
        return { ok: true };
    }

    const step = buildActionStep(action, scope, stepId);
    if (!step.ok) {return { ok: false, error: step.error };}

    const result = await executeStep(step.value);
    if (!result.ok) {
        return {
            ok: false,
            error: result.error || { code: 'ERR_CHECKPOINT_STEP_FAILED', message: `checkpoint action ${action.type} failed` },
        };
    }
    if (action.saveAs) {
        const set = setScopeValue(scope, normalizeSavePath(action.saveAs), result.data);
        if (!set.ok) {return { ok: false, error: set.error };}
    }
    return { ok: true };
};

const buildActionStep = (
    action: CheckpointAction,
    scope: CheckpointScope,
    stepId: string,
): { ok: true; value: StepUnion } | { ok: false; error: StepResult['error'] } => {
    if (action.type === 'snapshot') {
        const resolved = resolveCheckpointValue(action.args || {}, scope);
        if (!resolved.ok) {return { ok: false, error: resolved.error };}
        return {
            ok: true,
            value: {
                id: stepId,
                name: 'browser.snapshot',
                args: resolved.value as Step<'browser.snapshot'>['args'],
            },
        };
    }
    if (action.type === 'act') {
        const resolved = resolveCheckpointValue(action.step.args, scope);
        if (!resolved.ok) {return { ok: false, error: resolved.error };}
        return {
            ok: true,
            value: {
                id: stepId,
                name: action.step.name,
                args: resolved.value as never,
            } as StepUnion,
        };
    }
    if (action.type === 'query') {
        const resolved = resolveCheckpointValue(action.args, scope);
        if (!resolved.ok) {return { ok: false, error: resolved.error };}
        return {
            ok: true,
            value: {
                id: stepId,
                name: 'browser.query',
                args: resolved.value as Step<'browser.query'>['args'],
            },
        };
    }
    if (action.type === 'compute') {
        const resolved = resolveCheckpointValue(action.args, scope);
        if (!resolved.ok) {return { ok: false, error: resolved.error };}
        return {
            ok: true,
            value: {
                id: stepId,
                name: 'browser.compute',
                args: resolved.value as Step<'browser.compute'>['args'],
            },
        };
    }
    return {
        ok: false,
        error: {
            code: ACTION_UNSUPPORTED,
            message: `checkpoint action ${action.type} is not supported`,
        },
    };
};

const evaluateOutput = (
    output: Checkpoint['output'],
    scope: CheckpointScope,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: StepResult['error'] } => {
    if (!output) {
        return { ok: true, value: {} };
    }
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(output)) {
        if (key.includes('.') && !key.startsWith('output.')) {
            return {
                ok: false,
                error: {
                    code: OUTPUT_PATH_INVALID,
                    message: `invalid output path: ${key}`,
                },
            };
        }
        const target = key.startsWith('output.') ? key : `output.${key}`;
        const set = setScopeValue(scope, target, undefined);
        if (!set.ok) {return { ok: false, error: set.error };}
        const resolved = resolveCheckpointValue(value, scope);
        if (!resolved.ok) {return { ok: false, error: resolved.error };}
        const committed = setScopeValue(scope, target, resolved.value);
        if (!committed.ok) {return { ok: false, error: committed.error };}
        next[target.slice('output.'.length)] = resolved.value;
    }
    return { ok: true, value: next };
};

export const resolveCheckpointValue = (
    value: CheckpointValue,
    scope: CheckpointScope,
): { ok: true; value: unknown } | { ok: false; error: StepResult['error'] } => {
    if (isRefObject(value)) {
        return getScopeValue(scope, value.ref);
    }
    if (Array.isArray(value)) {
        const out: unknown[] = [];
        for (const item of value) {
            const resolved = resolveCheckpointValue(item as CheckpointValue, scope);
            if (!resolved.ok) {return resolved;}
            out.push(resolved.value);
        }
        return { ok: true, value: out };
    }
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            const resolved = resolveCheckpointValue(item, scope);
            if (!resolved.ok) {return resolved;}
            out[key] = resolved.value;
        }
        return { ok: true, value: out };
    }
    return { ok: true, value };
};

const isCheckpointAction = (value: SerializedStepUnion | CheckpointAction): value is CheckpointAction => {
    return Boolean(value && typeof value === 'object' && 'type' in value);
};

const isRefObject = (value: unknown): value is { ref: string } => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {return false;}
    const keys = Object.keys(value);
    return keys.length === 1 && keys[0] === 'ref' && typeof (value as { ref?: unknown }).ref === 'string';
};

const getScopeValue = (
    scope: CheckpointScope,
    path: string,
): { ok: true; value: unknown } | { ok: false; error: StepResult['error'] } => {
    const parsed = parseScopePath(path);
    if (!parsed.ok) {return parsed;}
    let cursor: unknown = scope[parsed.root];
    for (const segment of parsed.segments) {
        if (!cursor || typeof cursor !== 'object' || !(segment in (cursor as Record<string, unknown>))) {
            return {
                ok: false,
                error: {
                    code: REF_NOT_FOUND,
                    message: `checkpoint ref not found: ${path}`,
                },
            };
        }
        cursor = (cursor as Record<string, unknown>)[segment];
    }
    return { ok: true, value: cursor };
};

const setScopeValue = (
    scope: CheckpointScope,
    path: string,
    value: unknown,
): { ok: true } | { ok: false; error: StepResult['error'] } => {
    const parsed = parseScopePath(path);
    if (!parsed.ok) {return parsed;}
    if (parsed.root !== 'local' && parsed.root !== 'output') {
        return {
            ok: false,
            error: {
                code: OUTPUT_PATH_INVALID,
                message: `invalid output path: ${path}`,
            },
        };
    }
    let cursor = scope[parsed.root];
    for (let i = 0; i < parsed.segments.length - 1; i += 1) {
        const segment = parsed.segments[i];
        const current = cursor[segment];
        if (!current || typeof current !== 'object') {
            cursor[segment] = {};
        }
        cursor = cursor[segment] as Record<string, unknown>;
    }
    const leaf = parsed.segments[parsed.segments.length - 1];
    if (!leaf) {
        return {
            ok: false,
            error: {
                code: OUTPUT_PATH_INVALID,
                message: `invalid output path: ${path}`,
            },
        };
    }
    cursor[leaf] = value;
    return { ok: true };
};

const parseScopePath = (
    path: string,
): { ok: true; root: keyof CheckpointScope; segments: string[] } | { ok: false; error: StepResult['error'] } => {
    if (!path || typeof path !== 'string') {
        return {
            ok: false,
            error: {
                code: REF_INVALID,
                message: 'checkpoint path is required',
            },
        };
    }
    const segments = path.split('.').filter(Boolean);
    const root = segments.shift();
    if (!root || (root !== 'input' && root !== 'local' && root !== 'output')) {
        return {
            ok: false,
            error: {
                code: REF_INVALID,
                message: `invalid checkpoint path: ${path}`,
            },
        };
    }
    return { ok: true, root, segments };
};

const normalizeSavePath = (saveAs: string): string => {
    const trimmed = saveAs.trim();
    if (!trimmed) {return 'local.__invalid__';}
    if (trimmed.startsWith('local.') || trimmed.startsWith('output.')) {return trimmed;}
    return `local.${trimmed}`;
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
