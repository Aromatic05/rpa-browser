import { runDslSource } from '../dsl/runtime';
import type { ControlRouterContext } from './router';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const badRequest = (message: string): Error =>
    Object.assign(new Error(message), { code: 'ERR_CONTROL_BAD_REQUEST' });

export const runDslControl = async (
    params: unknown,
    ctx: ControlRouterContext,
): Promise<unknown> => {
    if (!isRecord(params)) {
        throw badRequest('dsl.run params must be an object');
    }
    if (typeof params.workspaceId !== 'string' || params.workspaceId.length === 0) {
        throw badRequest('workspaceId is required');
    }
    if (typeof params.source !== 'string' || params.source.length === 0) {
        throw badRequest('source is required');
    }

    const result = await runDslSource(params.source, {
        workspaceId: params.workspaceId,
        deps: ctx.deps,
        input: isRecord(params.input) ? params.input : undefined,
        checkpointProvider: ctx.checkpointProvider,
    });

    return {
        scope: result.scope,
        diagnostics: result.diagnostics,
    };
};
