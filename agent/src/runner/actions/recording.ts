import type { ActionHandler } from '../execute';
import type { RecordGetCommand, RecordReplayCommand, RecordStartCommand, RecordStopCommand } from '../commands';
import { startRecording, stopRecording, getRecording, ensureRecorder } from '../../record/recording';
import { replayRecording } from '../../play/replay';

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
  'record.replay': async (ctx, command) => {
    const args = (command as RecordReplayCommand).args;
    const events = getRecording(ctx.recordingState, ctx.tabToken);
    const response = await replayRecording(ctx.page, events, ctx.replayOptions, {
      stopOnError: args?.stopOnError ?? true
    });
    return { ok: response.ok, tabToken: ctx.tabToken, data: response.data };
  }
};
