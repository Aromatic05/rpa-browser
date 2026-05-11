import type { Page } from 'playwright';
import type { RecorderEvent } from '../capture/recorder';
import type { RecordingState } from './state';
import type { StepUnion } from '../../runner/steps/types';
import type { NormalizeContext } from '../normalizer';
import { flushPendingChoiceEvents as flushChoiceEventsFromNormalizer } from '../normalizer/select_option';
import { insertRecordingStepByRecordedTs } from './order';

type PendingFlushOptions = { exceptKey?: string; workspaceName?: string; page?: Page };

type PendingFlushHooks = {
    toStep: (event: RecorderEvent) => StepUnion | null;
    enrichRecordedStep: (state: RecordingState, recordingToken: string, sourceTabName: string, step: StepUnion) => StepUnion;
    startRecordedStepEnrichment: (input: {
        state: RecordingState;
        recordingToken: string;
        stepId: string;
        event: RecorderEvent;
        page?: Page;
        workspaceName: string;
        stepName: import('../../runner/steps/types').StepName;
        ts?: number;
        tabName?: string;
    }) => void;
};

export const isFillLikeEvent = (event: RecorderEvent): boolean => {
    return (event.type === 'input' || event.type === 'change' || event.type === 'paste' || event.type === 'date')
        && typeof event.selector === 'string'
        && event.selector.trim().length > 0
        && typeof event.value === 'string';
};

export const fillEventKey = (tabName: string, selector: string): string => `${tabName}::${selector}`;

export const queuePendingFillEvent = (state: RecordingState, recordingToken: string, tabName: string, event: RecorderEvent): void => {
    const selector = (event.selector || '').trim();
    if (!selector) {return;}
    let pending = state.pendingFillEvents.get(recordingToken);
    if (!pending) {
        pending = new Map();
        state.pendingFillEvents.set(recordingToken, pending);
    }
    pending.set(fillEventKey(tabName, selector), { event: { ...event, selector }, tabName });
};

export const flushPendingFillEvents = (
    state: RecordingState,
    recordingToken: string,
    options?: PendingFlushOptions,
    hooks?: PendingFlushHooks,
): void => {
    const pending = state.pendingFillEvents.get(recordingToken);
    if (!pending || pending.size === 0) {return;}
    if (!hooks) {
        if (options?.exceptKey) {
            pending.delete(options.exceptKey);
        }
        if (pending.size === 0) {
            state.pendingFillEvents.delete(recordingToken);
        }
        return;
    }
    const list = state.recordings.get(recordingToken) || [];
    const entries = Array.from(pending.entries())
        .filter(([key]) => key !== options?.exceptKey)
        .map(([key, item]) => ({ key, item }))
        .sort((a, b) => (a.item.event.ts || 0) - (b.item.event.ts || 0));
    for (const entry of entries) {
        const step = hooks.toStep(entry.item.event);
        if (!step) {
            pending.delete(entry.key);
            continue;
        }
        const normalized = hooks.enrichRecordedStep(state, recordingToken, entry.item.tabName, step);
        insertRecordingStepByRecordedTs(list, normalized);
        state.recordings.set(recordingToken, list);
        pending.delete(entry.key);
        hooks.startRecordedStepEnrichment({
            state,
            recordingToken,
            stepId: normalized.id,
            event: entry.item.event,
            page: options?.page,
            workspaceName: options?.workspaceName || (normalized.meta?.workspaceName || ''),
            stepName: normalized.name,
            ts: normalized.meta?.ts,
            tabName: normalized.meta?.tabName || entry.item.tabName,
        });
    }
    if (pending.size === 0) {
        state.pendingFillEvents.delete(recordingToken);
    }
};

export const queueRecordingStep = (
    state: RecordingState,
    recordingToken: string,
    tabName: string,
    step: StepUnion,
    event: RecorderEvent,
    hooks: PendingFlushHooks,
    options?: PendingFlushOptions,
): void => {
    const list = state.recordings.get(recordingToken) || [];
    const normalized = hooks.enrichRecordedStep(state, recordingToken, tabName, step);
    insertRecordingStepByRecordedTs(list, normalized);
    state.recordings.set(recordingToken, list);
    hooks.startRecordedStepEnrichment({
        state,
        recordingToken,
        stepId: normalized.id,
        event,
        page: options?.page,
        workspaceName: options?.workspaceName || (normalized.meta?.workspaceName || ''),
        stepName: normalized.name,
        ts: normalized.meta?.ts,
        tabName: normalized.meta?.tabName || tabName,
    });
};

export const flushPendingChoiceEvents = (
    state: RecordingState,
    recordingToken: string,
    context: NormalizeContext,
    hooks: PendingFlushHooks,
    options?: PendingFlushOptions & { reason?: 'navigate' | 'click' | 'stop' | 'save' | 'append_step' },
): void => {
    const emitted = flushChoiceEventsFromNormalizer({
        state,
        recordingToken,
        workspaceName: context.workspaceName,
        tabName: context.tabName,
        reason: options?.reason || 'navigate',
        context,
    });
    for (const item of emitted) {
        queueRecordingStep(state, recordingToken, context.tabName, item.step, item.event, hooks, options);
    }
};
