import type { Page } from 'playwright';
import { appendWorkspaceRecordingEvent, appendWorkspaceRecordingStep, type RecordingState } from './recording';
import type { RecorderEvent } from './recorder';
import type { StepUnion } from '../runner/steps/types';

export type RecorderIngestResult = {
    accepted: boolean;
    reason?: 'recording_not_enabled';
};

export type RecordPayloadIngestResult = {
    accepted: boolean;
    mode: 'raw-event' | 'step';
    reason?: 'recording_not_enabled';
};

export const ingestRecorderEvent = async (input: {
    state: RecordingState;
    workspaceName: string;
    event: RecorderEvent;
    page: Page;
    tabName: string;
    navDedupeWindowMs: number;
}): Promise<RecorderIngestResult> => {
    const appended = await appendWorkspaceRecordingEvent(
        input.state,
        input.workspaceName,
        input.tabName,
        input.event,
        input.navDedupeWindowMs,
        input.page,
    );
    if (!appended.accepted) {
        return { accepted: false, reason: 'recording_not_enabled' };
    }
    return { accepted: true };
};

const isRawRecorderEventPayload = (payload: StepUnion | RecorderEvent): payload is RecorderEvent => {
    const maybe = payload as Partial<RecorderEvent>;
    return typeof maybe.type === 'string' && typeof maybe.tabName === 'string' && typeof maybe.ts === 'number';
};

export const ingestRecordPayload = async (input: {
    state: RecordingState;
    payload: StepUnion | RecorderEvent;
    page: Page | null;
    tabName: string;
    workspaceName: string;
    navDedupeWindowMs: number;
}): Promise<RecordPayloadIngestResult> => {
    if (isRawRecorderEventPayload(input.payload)) {
        const sourceTabName = (input.payload.tabName || '').trim() || input.tabName;
        const event = { ...input.payload, tabName: sourceTabName };
        const appended = await appendWorkspaceRecordingEvent(
            input.state,
            input.workspaceName,
            sourceTabName,
            event,
            input.navDedupeWindowMs,
            input.page || undefined,
        );
        if (!appended.accepted) {
            return { accepted: false, mode: 'raw-event', reason: 'recording_not_enabled' };
        }
        return { accepted: true, mode: 'raw-event' };
    }

    let currentUrl = '';
    try {
        currentUrl = input.page?.url?.() || '';
    } catch {}
    const normalizedStep: StepUnion = {
        ...input.payload,
        meta: {
            ...input.payload.meta,
            source: input.payload.meta?.source ?? 'record',
            ts: input.payload.meta?.ts ?? Date.now(),
            workspaceName: input.workspaceName,
            tabName: input.payload.meta?.tabName || input.tabName,
            tabRef: input.payload.meta?.tabRef || input.tabName,
            urlAtRecord: input.payload.meta?.urlAtRecord || currentUrl || undefined,
        },
    };
    const appended = appendWorkspaceRecordingStep(
        input.state,
        input.workspaceName,
        input.tabName,
        normalizedStep,
        input.navDedupeWindowMs,
    );
    if (!appended.accepted) {
        return { accepted: false, mode: 'step', reason: 'recording_not_enabled' };
    }
    return { accepted: true, mode: 'step' };
};
