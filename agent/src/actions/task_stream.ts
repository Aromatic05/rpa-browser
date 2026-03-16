import { makeErr, makeOk } from './action_protocol';
import type { ActionHandler } from './execute';
import { ERROR_CODES } from './error_codes';
import type { StepEnvelope } from '../task_stream/types';

export const taskStreamHandlers: Record<string, ActionHandler> = {
    'task.run.start': async (ctx, action) => {
        const payload = (action.payload || {}) as { taskId?: string; workspaceId?: string; runId?: string };
        const manager = ctx.taskRunManager;
        if (!manager) {
            return makeErr(ERROR_CODES.ERR_UNSUPPORTED, 'task stream manager unavailable');
        }
        const workspaceId = payload.workspaceId || action.scope?.workspaceId;
        const taskId = payload.taskId || action.id;
        if (!workspaceId) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'missing workspaceId');
        }
        if (!taskId) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'missing taskId');
        }
        const run = manager.createRun({ taskId, workspaceId, runId: payload.runId });
        return makeOk({ runId: run.runId, taskId: run.taskId, workspaceId: run.workspaceId, checkpoint: manager.checkpoint(run.runId) });
    },
    'task.run.push': async (ctx, action) => {
        const payload = (action.payload || {}) as { runId?: string; steps?: StepEnvelope[]; stopOnError?: boolean };
        const manager = ctx.taskRunManager;
        if (!manager) {
            return makeErr(ERROR_CODES.ERR_UNSUPPORTED, 'task stream manager unavailable');
        }
        if (!payload.runId) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'missing runId');
        }
        const steps = Array.isArray(payload.steps) ? payload.steps : [];
        try {
            const pushed = await manager.pushSteps({ runId: payload.runId, steps, stopOnError: payload.stopOnError });
            return makeOk({ runId: payload.runId, ...pushed });
        } catch (error) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, error instanceof Error ? error.message : String(error));
        }
    },
    'task.run.poll': async (ctx, action) => {
        const payload = (action.payload || {}) as { runId?: string; cursor?: number; limit?: number };
        const manager = ctx.taskRunManager;
        if (!manager) {
            return makeErr(ERROR_CODES.ERR_UNSUPPORTED, 'task stream manager unavailable');
        }
        if (!payload.runId) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'missing runId');
        }
        try {
            const polled = manager.pollResults({ runId: payload.runId, cursor: payload.cursor, limit: payload.limit });
            return makeOk({ runId: payload.runId, ...polled });
        } catch (error) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, error instanceof Error ? error.message : String(error));
        }
    },
    'task.run.checkpoint': async (ctx, action) => {
        const payload = (action.payload || {}) as { runId?: string };
        const manager = ctx.taskRunManager;
        if (!manager) {
            return makeErr(ERROR_CODES.ERR_UNSUPPORTED, 'task stream manager unavailable');
        }
        if (!payload.runId) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'missing runId');
        }
        try {
            return makeOk({ checkpoint: manager.checkpoint(payload.runId) });
        } catch (error) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, error instanceof Error ? error.message : String(error));
        }
    },
    'task.run.abort': async (ctx, action) => {
        const payload = (action.payload || {}) as { runId?: string };
        const manager = ctx.taskRunManager;
        if (!manager) {
            return makeErr(ERROR_CODES.ERR_UNSUPPORTED, 'task stream manager unavailable');
        }
        if (!payload.runId) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'missing runId');
        }
        try {
            return makeOk({ checkpoint: manager.abortRun(payload.runId) });
        } catch (error) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, error instanceof Error ? error.message : String(error));
        }
    },
};
