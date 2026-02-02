/**
 * recording action：record / play 相关动作。
 */

import type { Action, RecordEvent } from './action_protocol';
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
} from '../record/recording';
import { replayRecording } from '../play/replay';
import { ERROR_CODES } from './error_codes';

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
        const events = getRecording(ctx.recordingState, ctx.tabToken);
        return makeOk({ events });
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
        const events = getRecording(ctx.recordingState, ctx.tabToken);
        const scope = ctx.pageRegistry.resolveScopeFromToken(ctx.tabToken);
        beginReplay(ctx.recordingState, ctx.tabToken);
        const response = await replayRecording({
            workspaceId: scope.workspaceId,
            events,
            stopOnError: payload.stopOnError ?? true,
        });
        endReplay(ctx.recordingState, ctx.tabToken);
        if (!response.ok) {
            return makeErr(
                ERROR_CODES.ERR_ASSERTION_FAILED,
                response.error?.message || 'replay failed',
                response.error?.details,
            );
        }
        return makeOk(response.results);
    },
    'record.event': async (ctx, action) => {
        const event = action.payload as RecordEvent | undefined;
        if (!event) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'missing record.event payload');
        }
        // 为保持回放可用：此处仅确认收到，不写入录制队列。
        void event;
        return makeOk({ accepted: true, ignored: true });
    },
};
