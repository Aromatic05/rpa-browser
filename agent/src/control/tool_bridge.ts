import crypto from 'node:crypto';
import { createDslTaskRunner } from '../dsl/runtime';
import type { ControlRouterContext } from './router';
import type { StepArgsMap, StepName, StepUnion } from '../runner/steps/types';

type SupportedBrowserMethod = 'browser.query' | 'browser.click' | 'browser.fill' | 'browser.snapshot';

const SUPPORTED_BROWSER_METHODS = new Set<SupportedBrowserMethod>([
    'browser.query',
    'browser.click',
    'browser.fill',
    'browser.snapshot',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const badRequest = (message: string): Error =>
    Object.assign(new Error(message), { code: 'ERR_CONTROL_BAD_REQUEST' });

const assertWorkspaceName = (params: unknown): string => {
    if (!isRecord(params) || typeof params.workspaceName !== 'string' || params.workspaceName.length === 0) {
        throw badRequest('workspaceName is required');
    }
    return params.workspaceName;
};

const resolveArgs = <T extends keyof StepArgsMap>(params: unknown, method: T): StepArgsMap[T] => {
    if (!isRecord(params)) {
        throw badRequest(`${method} params must be an object`);
    }
    if (method === 'browser.snapshot' && !Object.prototype.hasOwnProperty.call(params, 'args')) {
        return {} as StepArgsMap[T];
    }
    return (params.args ?? {}) as StepArgsMap[T];
};

export const runBrowserTool = async (
    method: string,
    params: unknown,
    ctx: ControlRouterContext,
): Promise<unknown> => {
    if (!SUPPORTED_BROWSER_METHODS.has(method as SupportedBrowserMethod)) {
        throw badRequest(`unsupported browser tool: ${method}`);
    }

    const workspaceName = assertWorkspaceName(params);
    const step: StepUnion = {
        id: crypto.randomUUID(),
        name: method as StepName,
        args: resolveArgs(params, method as keyof StepArgsMap),
        meta: {
            source: 'control-rpc',
            ts: Date.now(),
            workspaceName,
        },
    } as StepUnion;

    const runner = createDslTaskRunner({
        workspaceName,
        deps: ctx.deps,
        stopOnError: true,
    });

    await runner.start();
    try {
        return await runner.runStep(step);
    } finally {
        await runner.close();
    }
};
