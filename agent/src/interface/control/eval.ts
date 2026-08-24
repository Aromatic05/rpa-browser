import type { Action } from '../actions/action_protocol';
import type { RunnerConfig } from '../../platform/config';
import { runDslSource } from '../../program/dsl/runtime';
import type { DslCheckpointProvider } from '../../program/dsl/emit';
import type { RunStepsDeps } from '../../automation/runner/run_steps';
import type { StepResult, StepUnion } from '../../automation/runner/steps/types';
import type { WorkspaceRegistry } from '../../automation/runtime/workspace/registry';
import { runStepList } from '../../automation/runner/run_steps';
import type { ControlEvalRequest, ControlEvalResponse } from './protocol';

export type ControlEvalContextDeps = {
    deps: RunStepsDeps;
    workspaceRegistry: WorkspaceRegistry;
    config: RunnerConfig;
    dispatch: (action: Action) => Promise<Action>;
    resolveWorkspace: (workspaceName: string) => ReturnType<WorkspaceRegistry['getWorkspace']>;
    checkpointProvider?: (workspaceName: string) => DslCheckpointProvider | undefined;
};

const evalState: Record<string, unknown> = {};

export type ControlEvalRuntimeContext = {
    deps: RunStepsDeps;
    workspaceRegistry: WorkspaceRegistry;
    config: RunnerConfig;
    dispatch: (action: Action) => Promise<Action>;
    resolveWorkspace: (workspaceName?: string) => ReturnType<WorkspaceRegistry['getWorkspace']>;
    runStep: (step: StepUnion, workspaceName?: string) => Promise<StepResult>;
    runDsl: (source: string, input?: Record<string, unknown>, workspaceName?: string) => Promise<unknown>;
    log: (...args: unknown[]) => void;
    sleep: (ms: number) => Promise<void>;
    state: Record<string, unknown>;
    input: unknown;
    workspaceName?: string;
};

const toError = (error: unknown): { name: string; message: string; stack: string } => {
    if (error instanceof Error) {
        return {
            name: error.name || 'Error',
            message: error.message,
            stack: error.stack || `${error.name || 'Error'}: ${error.message}`,
        };
    }
    const message = unknownText(error);
    return { name: 'Error', message, stack: `Error: ${message}` };
};


const unknownText = (value: unknown): string => {
    if (typeof value === 'string') {return value;}
    if (value instanceof Error) {return value.message;}
    if (value === null) {return 'null';}
    if (value === undefined) {return 'undefined';}
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return `${value}`;
    }
    if (typeof value === 'symbol') {return value.description ?? 'symbol';}
    try {
        const serialized = JSON.stringify(value);
        return typeof serialized === 'string' ? serialized : Object.prototype.toString.call(value);
    } catch {
        return Object.prototype.toString.call(value);
    }
};

const toSummaryString = (value: unknown): string => {
    const tag = Object.prototype.toString.call(value);
    if (typeof value === 'function') {
        return `[function ${value.name || 'anonymous'}]`;
    }
    return `[unserializable ${tag}]`;
};

const toJsonSafe = (value: unknown, seen = new WeakSet(), depth = 0): unknown => {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (typeof value === 'undefined') {
        return null;
    }
    if (typeof value === 'function' || typeof value === 'symbol') {
        return toSummaryString(value);
    }
    if (depth > 8) {
        return '[max-depth]';
    }
    if (Array.isArray(value)) {
        return value.map((item) => toJsonSafe(item, seen, depth + 1));
    }
    if (typeof value === 'object') {
        if (seen.has(value)) {
            return '[circular]';
        }
        seen.add(value);
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = toJsonSafe(v, seen, depth + 1);
        }
        return out;
    }
    return '[unknown]';
};

const resolveWorkspaceName = (request: ControlEvalRequest): string => request.workspaceName || 'default';

const runWithTimeout = async <T>(task: Promise<T>, timeoutMs?: number): Promise<T> => {
    if (!timeoutMs) {
        return await task;
    }
    return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`eval timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        void task.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error instanceof Error ? error : new Error('control eval task failed', {cause: error}));
            },
        );
    });
};

export const runControlEval = async (
    request: ControlEvalRequest,
    contextDeps: ControlEvalContextDeps,
): Promise<ControlEvalResponse> => {
    const logs: string[] = [];
    if (process.env.RPA_CONTROL_EVAL !== '1') {
        return {
            id: request.id,
            ok: false,
            logs,
            error: {
                code: 'ERR_CONTROL_EVAL_DISABLED',
                name: 'ControlEvalDisabledError',
                message: 'control eval is disabled; set RPA_CONTROL_EVAL=1 to enable',
                stack: 'ControlEvalDisabledError: control eval is disabled; set RPA_CONTROL_EVAL=1 to enable',
            },
        };
    }

    const ctx: ControlEvalRuntimeContext = {
        deps: contextDeps.deps,
        workspaceRegistry: contextDeps.workspaceRegistry,
        config: contextDeps.config,
        dispatch: contextDeps.dispatch,
        resolveWorkspace: (workspaceName) => contextDeps.resolveWorkspace(workspaceName || resolveWorkspaceName(request)),
        runStep: async (step, workspaceName) => {
            const result = await runStepList(workspaceName || resolveWorkspaceName(request), [step], contextDeps.deps, {
                stopOnError: true,
            });
            return result.pipe.items[0];
        },
        runDsl: async (source, input, workspaceName) => {
            const runResult = await runDslSource(source, {
                workspaceName: workspaceName || resolveWorkspaceName(request),
                deps: contextDeps.deps,
                input,
                checkpointProvider: contextDeps.checkpointProvider?.(workspaceName || resolveWorkspaceName(request)),
            });
            return runResult;
        },
        log: (...args) => {
            const line = args
                .map((arg) => {
                    if (typeof arg === 'string') {
                        return arg;
                    }
                    try {
                        return JSON.stringify(toJsonSafe(arg));
                    } catch {
                        return String(arg);
                    }
                })
                .join(' ');
            logs.push(line);
        },
        sleep: async (ms) => {
            await new Promise<void>((resolve) => {
                setTimeout(() => {
                    resolve();
                }, ms);
            });
        },
        state: evalState,
        input: request.input,
        workspaceName: request.workspaceName,
    };

    try {
        const fn = new Function(
            'ctx',
            'input',
            `"use strict"; return (async () => {\n${request.source}\n})();`,
        ) as (ctx: ControlEvalRuntimeContext, input: unknown) => Promise<unknown>;
        const value = await runWithTimeout(fn(ctx, request.input), request.timeoutMs);
        return {
            id: request.id,
            ok: true,
            logs,
            result: toJsonSafe(value),
        };
    } catch (error) {
        const wrapped = toError(error);
        return {
            id: request.id,
            ok: false,
            logs,
            error: {
                code: 'ERR_CONTROL_EVAL_FAILED',
                name: wrapped.name,
                message: wrapped.message,
                stack: wrapped.stack,
            },
        };
    }
};
