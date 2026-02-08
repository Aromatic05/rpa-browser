/**
 * recording action：record / play 相关动作。
 */

import type { Action } from './action_protocol';
import { makeErr, makeOk } from './action_protocol';
import type { ActionHandler } from './execute';
import {
    startRecording,
    stopRecording,
    getRecording,
    clearRecording,
    ensureRecorder,
    beginReplay,
    endReplay,
    cancelReplay,
    recordEvent,
    recordStep,
} from '../record/recording';
import { runSteps } from '../runner/run_steps';
import { ERROR_CODES } from './error_codes';
import type { StepUnion } from '../runner/steps/types';

export const recordingHandlers: Record<string, ActionHandler> = {
    'record.start': async (ctx, _action) => {
        await startRecording(ctx.recordingState, ctx.page, ctx.tabToken, ctx.navDedupeWindowMs);
        await ensureRecorder(ctx.recordingState, ctx.page, ctx.tabToken, ctx.navDedupeWindowMs);
        return makeOk({ pageUrl: ctx.page.url() });
    },
    'record.stop': async (ctx, _action) => {
        stopRecording(ctx.recordingState, ctx.tabToken);
        return makeOk({ pageUrl: ctx.page.url() });
    },
    'record.get': async (ctx, _action) => {
        const steps = getRecording(ctx.recordingState, ctx.tabToken);
        return makeOk({ steps });
    },
    'record.clear': async (ctx, _action) => {
        clearRecording(ctx.recordingState, ctx.tabToken);
        return makeOk({ cleared: true });
    },
    'play.stop': async (ctx, _action) => {
        cancelReplay(ctx.recordingState, ctx.tabToken);
        return makeOk({ stopped: true });
    },
    'play.start': async (ctx, action) => {
        const payload = (action.payload || {}) as { stopOnError?: boolean };
        const steps = getRecording(ctx.recordingState, ctx.tabToken);
        const scope = ctx.pageRegistry.resolveScopeFromToken(ctx.tabToken);
        beginReplay(ctx.recordingState, ctx.tabToken);
        const response = await runSteps({
            workspaceId: scope.workspaceId,
            steps,
            options: { stopOnError: payload.stopOnError ?? true },
        });
        endReplay(ctx.recordingState, ctx.tabToken);
        if (!response.ok) {
            return makeErr(
                ERROR_CODES.ERR_ASSERTION_FAILED,
                response.error?.message || 'replay failed',
                { results: response.results, error: response.error },
            );
        }
        return makeOk({ results: response.results });
    },
    'record.event': async (ctx, action) => {
        const step = action.payload as StepUnion | undefined;
        if (!step) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'missing record.event payload');
        }
        recordStep(ctx.recordingState, ctx.tabToken, step, ctx.navDedupeWindowMs);
        return makeOk({ accepted: true });
    },
};
