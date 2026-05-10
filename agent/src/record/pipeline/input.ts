import type { Page } from 'playwright';
import { appendWorkspaceRecordingEvent, appendWorkspaceRecordingStep } from './step';
import type { RecordingState } from './state';
import type { RecorderEvent } from '../capture/recorder';
import type { StepUnion } from '../../runner/steps/types';
import { recordFirstTabPageUrl } from '../tab_lifecycle_recorder';

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
    if (input.event.type !== 'navigate') {
        flushFirstTabGotoAtIngestBoundary({
            state: input.state,
            workspaceName: input.workspaceName,
            tabName: input.tabName,
            page: input.page,
            at: input.event.ts,
            navDedupeWindowMs: input.navDedupeWindowMs,
        });
    }
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

const readPageUrl = (page: Page | null | undefined): string => {
    try {
        return page?.url?.() || '';
    } catch {
        return '';
    }
};

const flushFirstTabGotoAtIngestBoundary = (input: {
    state: RecordingState;
    workspaceName: string;
    tabName: string;
    url?: string;
    page?: Page | null;
    at?: number;
    navDedupeWindowMs: number;
}): void => {
    const url = input.url || readPageUrl(input.page);
    if (!url) {return;}
    recordFirstTabPageUrl(input.state, {
        workspaceName: input.workspaceName,
        tabName: input.tabName,
        tabRef: input.tabName,
        url,
        urlAtRecord: url,
        at: input.at,
        navDedupeWindowMs: input.navDedupeWindowMs,
    });
};

export const ingestRecordPayload = async (input: {
    state: RecordingState;
    payload: StepUnion | RecorderEvent;
    page: Page | null;
    tabName: string;
    currentUrl?: string;
    workspaceName: string;
    navDedupeWindowMs: number;
}): Promise<RecordPayloadIngestResult> => {
    if (isRawRecorderEventPayload(input.payload)) {
        const sourceTabName = (input.payload.tabName || '').trim() || input.tabName;
        const event = { ...input.payload, tabName: sourceTabName };
        if (event.type !== 'navigate') {
            flushFirstTabGotoAtIngestBoundary({
                state: input.state,
                workspaceName: input.workspaceName,
                tabName: sourceTabName,
                url: typeof event.url === 'string' ? event.url : input.currentUrl,
                page: input.page,
                at: event.ts,
                navDedupeWindowMs: input.navDedupeWindowMs,
            });
        }
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

    const currentUrl = input.currentUrl || readPageUrl(input.page);
    if (input.payload.name !== 'browser.goto') {
        const stepTabName = input.payload.meta?.tabName || input.tabName;
        flushFirstTabGotoAtIngestBoundary({
            state: input.state,
            workspaceName: input.workspaceName,
            tabName: stepTabName,
            url: currentUrl,
            page: input.page,
            at: input.payload.meta?.ts,
            navDedupeWindowMs: input.navDedupeWindowMs,
        });
    }
    const normalizedStep: StepUnion = {
        ...input.payload,
        meta: {
            ...input.payload.meta,
            source: input.payload.meta?.source ?? 'record',
            ts: input.payload.meta?.ts ?? Date.now(),
            workspaceName: input.workspaceName,
            tabName: input.payload.meta?.tabName || input.tabName,
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
