import type { RunStepsDeps } from '../runner/run_steps';
import type { DslCheckpointProvider } from '../dsl/emit';
import type { ControlRequest, ControlResponse } from './protocol';
import { callActionFromControl } from './action_bridge';
import { runDslControl } from './dsl_bridge';
import { runBrowserTool } from './tool_bridge';

export type ControlHandler = (
    params: unknown,
    ctx: ControlRouterContext,
) => Promise<unknown>;

export type ControlRouterContext = {
    deps: RunStepsDeps;
    workspaceName?: string;
    checkpointProvider?: DslCheckpointProvider;
};

export type ControlRouter = {
    handle(req: ControlRequest): Promise<ControlResponse>;
};

class ControlRouterError extends Error {
    code: string;
    details?: unknown;

    constructor(code: string, message: string, details?: unknown) {
        super(message);
        this.code = code;
        this.details = details;
    }
}

const handlerError = (error: unknown): { code: string; message: string; details?: unknown } => {
    if (error instanceof ControlRouterError) {
        return { code: error.code, message: error.message, details: error.details };
    }
    if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof (error as { code?: unknown }).code === 'string'
    ) {
        return {
            code: (error as { code: string }).code,
            message: error instanceof Error ? error.message : String(error),
        };
    }
    if (error instanceof Error) {
        return { code: 'ERR_CONTROL_INTERNAL', message: error.message };
    }
    return { code: 'ERR_CONTROL_INTERNAL', message: String(error) };
};

export const createControlRouter = (ctx: ControlRouterContext): ControlRouter => {
    const resolveWorkspaceParams = (params: unknown): unknown => {
        if (ctx.workspaceName && typeof params === 'object' && params !== null && !Array.isArray(params)) {
            const record = params as Record<string, unknown>;
            if (typeof record.workspaceName !== 'string') {
                return { workspaceName: ctx.workspaceName, ...record };
            }
        }
        return params;
    };

    const handlers = new Map<string, ControlHandler>([
        ['agent.ping', async () => ({ ok: true, ts: Date.now() })],
        ['dsl.run', async (params, innerCtx) => await runDslControl(resolveWorkspaceParams(params), innerCtx)],
        ['browser.query', async (params, innerCtx) => await runBrowserTool('browser.query', resolveWorkspaceParams(params), innerCtx)],
        ['browser.click', async (params, innerCtx) => await runBrowserTool('browser.click', resolveWorkspaceParams(params), innerCtx)],
        ['browser.fill', async (params, innerCtx) => await runBrowserTool('browser.fill', resolveWorkspaceParams(params), innerCtx)],
        ['browser.snapshot', async (params, innerCtx) => await runBrowserTool('browser.snapshot', resolveWorkspaceParams(params), innerCtx)],
        ['action.call', async (params, innerCtx) => await callActionFromControl(params, innerCtx)],
    ]);

    return {
        async handle(req: ControlRequest): Promise<ControlResponse> {
            const handler = handlers.get(req.method);
            if (!handler) {
                return {
                    id: req.id,
                    ok: false,
                    error: {
                        code: 'ERR_CONTROL_METHOD_NOT_FOUND',
                        message: `control method not found: ${req.method}`,
                    },
                };
            }
            try {
                const result = await handler(req.params, ctx);
                return {
                    id: req.id,
                    ok: true,
                    ...(typeof result === 'undefined' ? {} : { result }),
                };
            } catch (error) {
                const mapped = handlerError(error);
                return {
                    id: req.id,
                    ok: false,
                    error: mapped,
                };
            }
        },
    };
};
