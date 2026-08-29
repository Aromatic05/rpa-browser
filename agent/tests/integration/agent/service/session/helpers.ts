import type {AgentRunRequest, AgentRunResult} from '../../../../../src/agent/execution/types';
import type {AgentToolTrace} from '../../../../../src/agent/trace/collector';

export type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
};

export const deferred = <T>(): Deferred<T> => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return {promise, resolve, reject};
};

export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const makeTrace = () => ({
    metrics: {
        turns: 1,
        toolCalls: 0,
        readCalls: 0,
        controlCalls: 0,
        effectCalls: 0,
        failedToolCalls: 0,
        postErrorEffectCalls: 0,
    },
    tools: [],
});

export const makeResult = (overrides: Partial<AgentRunResult> = {}): AgentRunResult => ({
    provider: 'test',
    model: 'model',
    text: 'done',
    trace: makeTrace(),
    ...overrides,
});

export const makeResultWithSecret = (overrides: Partial<AgentRunResult> = {}): AgentRunResult => ({
    ...makeResult(),
    trace: {
        metrics: {
            turns: 1,
            toolCalls: 1,
            readCalls: 0,
            controlCalls: 0,
            effectCalls: 1,
            failedToolCalls: 0,
            postErrorEffectCalls: 0,
        },
        tools: [{
            toolCallId: 'tc1',
            toolName: 'effect.configure',
            classification: 'effect',
            args: {apiKey: 'raw-secret-value', safe: 'visible'},
            startedAt: Date.now(),
            endedAt: Date.now(),
            isError: false,
            worldBefore: null,
            worldAfter: null,
        } as AgentToolTrace],
    },
    ...overrides,
});

export const makeRequest = (overrides: Partial<AgentRunRequest> = {}): AgentRunRequest => ({
    prompt: 'do something',
    provider: 'test',
    model: 'model',
    ...overrides,
});
