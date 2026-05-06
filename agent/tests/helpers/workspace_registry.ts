import type { Page } from 'playwright';
import { createWorkspaceRegistry } from '../../src/runtime/workspace/registry';
import { createRecordingState, type RecordingState } from '../../src/record/recording';
import type { RunStepsDeps } from '../../src/runner/run_steps';
import { getRunnerConfig } from '../../src/config';
import type { Action } from '../../src/actions/action_protocol';
import { createPortAllocator } from '../../src/runtime/service/ports';
import { createExecutionBindings } from '../../src/runtime/execution/bindings';
import type { PageRegistry } from '../../src/runtime/browser/page_registry';

export type TestWorkspaceRegistryOptions = {
    recordingState?: RecordingState;
    getPage?: (tabName: string, startUrl?: string) => Promise<Page>;
    emit?: (action: Action) => void;
    runStepsDeps?: RunStepsDeps;
};

export const createTestWorkspaceRegistry = (options: TestWorkspaceRegistryOptions = {}) => {
    const recordingState = options.recordingState || createRecordingState();
    const testPageRegistry: PageRegistry = {
        bindPage: async () => null,
        getPage: options.getPage || (async (_tabName, startUrl) => ({
            url: () => startUrl || 'about:blank',
            isClosed: () => false,
            close: async () => undefined,
            on: () => undefined,
            addInitScript: async () => undefined,
            exposeBinding: async () => undefined,
            evaluate: async () => undefined,
            waitForTimeout: async () => undefined,
            mainFrame: () => ({ url: () => startUrl || 'about:blank' }),
            frames: () => [],
            context: () => ({}) as any,
        } as unknown as Page)),
        touchBinding: () => true,
        listStaleBindings: () => [],
        closePage: async () => undefined,
        createPendingBindingClaim: () => undefined,
        claimPendingBinding: async () => false,
    };
    const runtime = createExecutionBindings({});
    const runStepsDeps = options.runStepsDeps || ({
        runtime,
        pageRegistry: testPageRegistry,
        resolveWorkspace: () => { throw new Error('resolveWorkspace is not configured in test helper'); },
        stepSinks: [],
        config: getRunnerConfig(),
        pluginHost: {
            getExecutors: () => ({}),
        },
    } as unknown as RunStepsDeps);
    const registry = createWorkspaceRegistry({
        pageRegistry: testPageRegistry,
        runtime: runStepsDeps.runtime,
        recordingState,
        replayOptions: { clickDelayMs: 1, stepIntervalMs: 1, scroll: { minDelta: 1, maxDelta: 2, minSteps: 1, maxSteps: 2 } },
        navDedupeWindowMs: 1200,
        emit: options.emit,
        runStepsDeps,
        runnerConfig: getRunnerConfig(),
        portAllocator: createPortAllocator(20000),
    });
    runStepsDeps.resolveWorkspace = (workspaceName: string) => {
        const workspace = registry.getWorkspace(workspaceName);
        if (!workspace) {
            throw new Error(`workspace not found: ${workspaceName}`);
        }
        return workspace;
    };

    return { registry, recordingState, runStepsDeps };
};
