import type { Page } from 'playwright';
import { recordEvent, recordStep, type RecordingState } from './recording';
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

const resolveEnabledToken = (state: RecordingState, tabName: string): string | null => {
    if (state.recordingEnabled.has(tabName)) {
        return tabName;
    }
    if (state.recordingEnabled.size === 1) {
        return Array.from(state.recordingEnabled)[0];
    }
    return null;
};

export const ingestRecorderEvent = async (input: {
    state: RecordingState;
    event: RecorderEvent;
    page: Page;
    tabName: string;
    navDedupeWindowMs: number;
}): Promise<RecorderIngestResult> => {
    const effectiveToken = resolveEnabledToken(input.state, input.tabName);
    if (!effectiveToken) {
        return { accepted: false, reason: 'recording_not_enabled' };
    }

    const event = effectiveToken === input.tabName ? input.event : { ...input.event, tabName: effectiveToken };
    await recordEvent(input.state, event, input.navDedupeWindowMs, input.page);
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
    const effectiveToken = resolveEnabledToken(input.state, input.tabName);
    if (!effectiveToken) {
        return { accepted: false, mode: 'step', reason: 'recording_not_enabled' };
    }

    if (isRawRecorderEventPayload(input.payload)) {
        const event = effectiveToken === input.payload.tabName
            ? input.payload
            : { ...input.payload, tabName: effectiveToken };
        await recordEvent(input.state, event, input.navDedupeWindowMs, input.page || undefined);
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
            tabName: effectiveToken,
            tabRef: input.payload.meta?.tabRef || effectiveToken,
            urlAtRecord: input.payload.meta?.urlAtRecord || currentUrl || undefined,
        },
    };
    recordStep(input.state, effectiveToken, normalizedStep, input.navDedupeWindowMs);
    return { accepted: true, mode: 'step' };
};
