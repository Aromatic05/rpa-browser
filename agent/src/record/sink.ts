import crypto from 'node:crypto';
import type { Page } from 'playwright';
import type { Action } from '../actions/action_protocol';
import { ACTION_TYPES } from '../actions/action_types';
import type { RecordingState } from './recording';
import { setRecorderEventSink } from './recording';
import { ingestRecorderEvent } from './ingest';
import type { RecorderEvent } from './recorder';

export type RecorderSinkDeps = {
    recordingState: RecordingState;
    navDedupeWindowMs: number;
    emit: (action: Action) => void;
    findWorkspaceNameByTabName: (tabName: string) => string | null;
    wsTap?: (stage: string, data: Record<string, unknown>) => void;
};

export const createRecorderEventSinkHandler = (deps: RecorderSinkDeps) => {
    const wsTap = deps.wsTap || (() => undefined);
    return async (event: RecorderEvent, page: Page, tabName: string) => {
        const ingest = await ingestRecorderEvent({
            state: deps.recordingState,
            event,
            page,
            tabName,
            navDedupeWindowMs: deps.navDedupeWindowMs,
        });
        if (!ingest.accepted) {
            wsTap('agent.record_event.drop', {
                reason: ingest.reason || 'recording_not_enabled',
                sourceTabName: tabName,
                activeRecordingCount: deps.recordingState.recordingEnabled.size,
            });
            return;
        }

        const workspaceName = deps.findWorkspaceNameByTabName(tabName) || undefined;
        deps.emit({
            v: 1,
            id: crypto.randomUUID(),
            type: ACTION_TYPES.RECORD_EVENT,
            workspaceName,
            payload: event,
            at: event.ts || Date.now(),
        });
    };
};

export const installRecorderEventSink = (deps: RecorderSinkDeps): void => {
    setRecorderEventSink(createRecorderEventSinkHandler(deps));
};
