import type { Page } from 'playwright';
import { createWorkspaceRegistry } from '../../src/runtime/workspace/registry';
import { createRecordingState, type RecordingState } from '../../src/record/recording';
import type { RunStepsDeps } from '../../src/runner/run_steps';
import { getRunnerConfig } from '../../src/config';
import type { Action } from '../../src/actions/action_protocol';
import { createPortAllocator } from '../../src/runtime/service/ports';

export type TestWorkspaceRegistryOptions = {
    recordingState?: RecordingState;
    getPage?: (tabName: string, startUrl?: string) => Promise<Page>;
    emit?: (action: Action) => void;
    runStepsDeps?: RunStepsDeps;
};

export const createTestWorkspaceRegistry = (options: TestWorkspaceRegistryOptions = {}) => {
    const recordingState = options.recordingState || createRecordingState();
    const runStepsDeps = options.runStepsDeps || ({
        runtime: {
            resolveBinding: async () => ({ page: null, tabName: 'tab-1', workspaceName: 'test', traceCtx: { cache: {} } }),
            ensureActivePage: async () => ({ page: null, tabName: 'tab-1', workspaceName: 'test', traceCtx: { cache: {} } }),
        },
        stepSinks: [],
        config: getRunnerConfig(),
        pluginHost: {
            getExecutors: () => ({}),
        },
    } as unknown as RunStepsDeps);

    const registry = createWorkspaceRegistry({
        pageRegistry: {
            getPage: options.getPage || (async (_tabName, startUrl) => ({
                url: () => startUrl || 'about:blank',
                isClosed: () => false,
                close: async () => undefined,
            } as unknown as Page)),
        },
        recordingState,
        replayOptions: { clickDelayMs: 1, stepDelayMs: 1, scroll: { minDelta: 1, maxDelta: 2, minSteps: 1, maxSteps: 2 } },
        navDedupeWindowMs: 1200,
        emit: options.emit,
        runStepsDeps,
        runnerConfig: getRunnerConfig(),
        portAllocator: createPortAllocator(20000),
    });

    return { registry, recordingState, runStepsDeps };
};
