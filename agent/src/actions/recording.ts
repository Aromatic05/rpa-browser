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
import { ERROR_CODES } from './error_codes';
import type { StepUnion } from '../runner/steps/types';
import { replayRecording } from '../play/replay';

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
        try {
            const replayed = await replayRecording({
                workspaceId: scope.workspaceId,
                initialTabId: scope.tabId,
                initialTabToken: ctx.tabToken,
                steps,
                stopOnError,
                pageRegistry: {
                    listTabs: (workspaceId: string) => ctx.pageRegistry.listTabs(workspaceId),
                },
                isCanceled: () => ctx.recordingState.replayCancel.has(ctx.tabToken),
            });
            if (replayed.error?.code === 'ERR_CANCELED') {
                return makeOk({ stopped: true, canceled: true, results: replayed.results });
            }
            if (!replayed.ok && stopOnError) {
                const firstFailed = replayed.results.find((item) => !item.ok);
                return makeErr(
                    ERROR_CODES.ERR_ASSERTION_FAILED,
                    firstFailed?.error?.message || replayed.error?.message || 'replay failed',
                    { results: replayed.results, failed: firstFailed?.error || replayed.error },
                );
            }
            return makeOk({ results: replayed.results });
        } finally {
            endReplay(ctx.recordingState, ctx.tabToken);
        }
    },
    'record.event': async (ctx, action) => {
        const step = action.payload as StepUnion | undefined;
        if (!step) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'missing record.event payload');
        }
        const token = action.scope?.tabToken || action.tabToken || ctx.tabToken;
        const scope = ctx.pageRegistry.resolveScopeFromToken(token);
        const normalizedStep: StepUnion = {
            ...step,
            meta: {
                ...step.meta,
                source: step.meta?.source ?? 'record',
                ts: step.meta?.ts ?? Date.now(),
                workspaceId: scope.workspaceId,
                tabId: scope.tabId,
                tabToken: token,
            },
        };
        recordStep(ctx.recordingState, token, normalizedStep, ctx.navDedupeWindowMs);
        return makeOk({ accepted: true });
    },
};
