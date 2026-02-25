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
        const stopOnError = payload.stopOnError ?? true;
        const scope = ctx.pageRegistry.resolveScopeFromToken(ctx.tabToken);
        beginReplay(ctx.recordingState, ctx.tabToken);
        const stepResults: Array<{ stepId: string; ok: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown } }> = [];
        try {
            for (const step of steps) {
                if (ctx.recordingState.replayCancel.has(ctx.tabToken)) {
                    return makeOk({ stopped: true, canceled: true, results: stepResults });
                }
                const response = await runSteps({
                    workspaceId: scope.workspaceId,
                    steps: [step],
                    options: { stopOnError: true },
                });
                stepResults.push(...response.results);
                if (!response.ok && stopOnError) {
                    const firstFailed = response.results.find((item) => !item.ok);
                    return makeErr(
                        ERROR_CODES.ERR_ASSERTION_FAILED,
                        firstFailed?.error?.message || 'replay failed',
                        { results: stepResults, failed: firstFailed?.error },
                    );
                }
            }
        } finally {
            endReplay(ctx.recordingState, ctx.tabToken);
        }
        return makeOk({ results: stepResults });
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
