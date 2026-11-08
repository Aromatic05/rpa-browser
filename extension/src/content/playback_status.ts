import type {Action} from '../shared/types.js';
import {asRecordedFrameIssue, recordedFrameFeedback} from '../shared/recorded_frame_feedback.js';

type Step = {index: number; name: string};
type Failure = {step?: Step; code: string; reason: string};

export type PlaybackStatus = {
    replayId: string;
    phase: 'running' | 'completed' | 'failed' | 'canceled' | 'start-failed';
    completed: number;
    total?: number;
    current?: Step;
    failure?: Failure;
};

const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const count = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const stepFrom = (index: number | undefined, name: unknown): Step | undefined => index === undefined ? undefined : {
    index,
    name: typeof name === 'string' && /^browser\.[a-z_]{1,48}$/.test(name) ? name : '',
};

const reasonFor = (code: string, fallback: boolean): string => {
    switch (code) {
        case 'ERR_AMBIGUOUS':
            return fallback
                ? 'The saved backup clues match more than one element. This step was skipped.'
                : 'The recorded target matches more than one element.';
        case 'ERR_NOT_FOUND':
        case 'ERR_STALE':
        case 'ERR_UNRESOLVED':
            return 'The recorded target could not be located. Check the current page or record this step again.';
        case 'ERR_TIMEOUT':
        case 'ERR_PAGE_NOT_READY':
            return 'The page or target did not become ready in time.';
        case 'ERR_REPLAY_TAB_NOT_BOUND':
            return 'The recorded tab could not be matched to an open tab.';
        case 'ERR_REPLAY_TAB_INIT_FAILED':
            return 'The starting tab could not be prepared for playback.';
        case 'ERR_RECORDING_EMPTY':
            return 'There are no recorded steps to play.';
        case 'ERR_BAD_STATE':
            return 'The workspace is busy. Finish the current operation and try again.';
        default:
            return 'Check the page and the recording before trying again.';
    }
};

const failureFrom = (error: Record<string, unknown>, step?: Step): Failure => {
    const code = typeof error.code === 'string' && /^ERR_[A-Z0-9_]{1,60}$/.test(error.code)
        ? error.code : '';
    const details = record(error.details);
    const issue = asRecordedFrameIssue(details.frameIssue);
    return {step, code, reason: issue ? recordedFrameFeedback(issue) : reasonFor(code, details.resolution === 'recorded-target-fallback')};
};

export const updatePlaybackStatus = (
    previous: PlaybackStatus | undefined,
    action: Action,
    requestType?: string,
): PlaybackStatus | undefined => {
    const payload = record(action.payload);
    const replayId = payload.replayId;
    if (requestType === 'play.start' && action.type.endsWith('.failed') && typeof replayId !== 'string') {
        return previous?.phase === 'running' ? previous : {
            replayId: action.id, phase: 'start-failed', completed: 0, failure: failureFrom(payload),
        };
    }
    if (typeof replayId !== 'string' || !replayId) {return previous;}
    const sameReplay = previous?.replayId === replayId;
    const index = count(payload.index);
    const opensReplay = action.type === 'play.started'
        || (action.type === 'play.progress' && payload.completed === 0)
        || (action.type === 'play.step.started' && index === 0);
    if (previous && !sameReplay && !opensReplay) {return previous;}

    const status: PlaybackStatus = sameReplay
        ? previous
        : {replayId, phase: 'running', completed: 0};
    // A short replay can emit its terminal event before the start reply arrives.
    if (action.type === 'play.started') {return {...status, total: status.total ?? count(payload.stepCount)};}
    if (status.phase !== 'running') {return status;}

    const step = stepFrom(index, payload.stepName);
    const failedStep = record(payload.failedStep);
    const terminalStep = stepFrom(count(failedStep.index), failedStep.name);
    const total = count(payload.total) ?? status.total;
    switch (action.type) {
        case 'play.step.started':
            return {...status, total, current: step};
        case 'play.step.finished':
            return {
                ...status,
                total,
                completed: index === undefined ? status.completed : Math.max(status.completed, index + 1),
                current: undefined,
                failure: status.failure ?? (payload.ok === false ? failureFrom(record(payload.error), step) : undefined),
            };
        case 'play.progress':
            return {...status, total, completed: Math.max(status.completed, count(payload.completed) ?? 0)};
        case 'play.completed': {
            const results: unknown[] = Array.isArray(payload.results) ? payload.results : [];
            const failed = results.find((item) => record(item).ok === false);
            return {
                ...status, phase: 'completed', current: undefined,
                completed: Math.max(status.completed, results.length),
                failure: status.failure ?? (failed ? failureFrom(record(record(failed).error), terminalStep) : undefined),
            };
        }
        case 'play.failed': {
            const error = record(record(payload.details).failed);
            return {
                ...status, phase: 'failed', current: undefined,
                failure: typeof error.code === 'string'
                    ? failureFrom(error, terminalStep ?? status.current ?? (status.failure?.code === error.code ? status.failure.step : undefined))
                    : status.failure ?? failureFrom(payload, terminalStep ?? status.current),
            };
        }
        case 'play.canceled':
            return {...status, phase: 'canceled', current: undefined};
        default:
            return previous;
    }
};
