import type { ActionHandler } from '../execute';
import type {
    RecordReplayCommand,
} from '../commands';
import {
    startRecording,
    stopRecording,
    getRecording,
    clearRecording,
    ensureRecorder,
    beginReplay,
    endReplay,
    cancelReplay,
} from '../../record/recording';
import { replayRecording } from '../../play/replay';
import { errorResult } from '../results';
import { ERROR_CODES } from '../error_codes';

export const recordingHandlers: Record<string, ActionHandler> = {
    'record.start': async (ctx, _command) => {
        await startRecording(ctx.recordingState, ctx.page, ctx.tabToken, ctx.navDedupeWindowMs);
        await ensureRecorder(ctx.recordingState, ctx.page, ctx.tabToken, ctx.navDedupeWindowMs);
        return { ok: true, tabToken: ctx.tabToken, data: { pageUrl: ctx.page.url() } };
    },
    'record.stop': async (ctx, _command) => {
        stopRecording(ctx.recordingState, ctx.tabToken);
        return { ok: true, tabToken: ctx.tabToken, data: { pageUrl: ctx.page.url() } };
    },
    'record.get': async (ctx, _command) => {
        const events = getRecording(ctx.recordingState, ctx.tabToken);
        return { ok: true, tabToken: ctx.tabToken, data: { events } };
    },
    'record.clear': async (ctx, _command) => {
        clearRecording(ctx.recordingState, ctx.tabToken);
        return { ok: true, tabToken: ctx.tabToken, data: { cleared: true } };
    },
    'record.stopReplay': async (ctx, _command) => {
        cancelReplay(ctx.recordingState, ctx.tabToken);
        return { ok: true, tabToken: ctx.tabToken, data: { stopped: true } };
    },
    'record.replay': async (ctx, command) => {
        const args = (command as RecordReplayCommand).args;
        const events = getRecording(ctx.recordingState, ctx.tabToken);
        const scope = ctx.pageRegistry.resolveScopeFromToken(ctx.tabToken);
        beginReplay(ctx.recordingState, ctx.tabToken);
        const response = await replayRecording({
            workspaceId: scope.workspaceId,
            events,
            stopOnError: args?.stopOnError ?? true,
        });
        endReplay(ctx.recordingState, ctx.tabToken);
        if (!response.ok) {
            return errorResult(
                ctx.tabToken,
                ERROR_CODES.ERR_ASSERTION_FAILED,
                response.error?.message || 'replay failed',
                undefined,
                response.error?.details,
            );
        }
        return { ok: true, tabToken: ctx.tabToken, data: response.results };
    },
};
