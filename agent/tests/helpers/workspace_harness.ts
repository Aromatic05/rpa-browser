import type { Page } from 'playwright';
import { createWorkspaceRegistry } from '../../src/runtime/workspace/registry';
import { createRecordingState, type RecordingState } from '../../src/record/recording';
import {createRecordingSnapshotPort} from '../../src/record/pipeline/snapshot';
import {SnapshotProjectionBaselineStore} from '../../src/runner/session';
import {PageSnapshotSessionStore} from '../../src/snapshot';
import type { RunStepsDeps } from '../../src/runner/run_steps';
import { getRunnerConfig } from '../../src/config';
import type { Action } from '../../src/actions/action_protocol';
import { createPortAllocator } from '../../src/runtime/service/ports';
import { createExecutionBindings } from '../../src/runtime/execution/bindings';
import type { PageRegistry } from '../../src/runtime/browser/page_registry';
import type { WorkspaceBrowserSession } from '../../src/runtime/browser/browser_session';
import type { AgentModelRuntime } from '../../src/agent/model/runtime';

export type WorkspaceHarnessOptions = {
    recordingState?: RecordingState;
    getPage?: (tabName: string, startUrl?: string) => Promise<Page>;
    emit?: (action: Action) => void;
    runStepsDeps?: RunStepsDeps;
    pageRegistry?: PageRegistry;
    agentModelRuntime?: AgentModelRuntime;
    pluginHost?: RunStepsDeps['pluginHost'];
};

export const createWorkspaceHarness = (options: WorkspaceHarnessOptions = {}) => {
    const getPage = options.getPage || (async (_tabName, startUrl) => ({
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
    } as unknown as Page));
    const testPageRegistry: PageRegistry = options.pageRegistry || {
        createPage: async () => await getPage('', 'about:blank'),
        bindPage: async () => null,
        awaitPageBinding: async (bindingName) => await getPage(bindingName, 'about:blank'),
        createPageBinding: async (bindingName, input) => await getPage(bindingName, input?.startUrl),
        touchBinding: () => true,
        listStaleBindings: () => [],
        closePage: async () => undefined,
        debugPageBindings: async (bindingName) => ({
            bindingName,
            knownBindings: [],
            knownPagesSummary: [],
            pendingClaims: [],
        }),
        createPendingBindingClaim: () => undefined,
        claimPendingBinding: async () => false,
    };
    const runtime = createExecutionBindings({ pageRegistry: testPageRegistry });
    const runStepsDeps = options.runStepsDeps || ({
        runtime,
        pageSession: new PageSnapshotSessionStore(),
        snapshotProjection: new SnapshotProjectionBaselineStore(),
        resolveWorkspace: () => {
            throw new Error('resolveWorkspace is not configured in test helper');
        },
        stepSinks: [],
        config: getRunnerConfig(),
        pluginHost: options.pluginHost ?? {
            getExecutors: () => ({}),
        },
        dispatchAction: async (action: Action) => ({
            ...action,
            id: `${action.id}-reply`,
            type: `${action.type}.result`,
            replyTo: action.id,
        }),
    } as unknown as RunStepsDeps);
    const recordingState = options.recordingState || createRecordingState({
        snapshotPort: createRecordingSnapshotPort(runStepsDeps),
    });
    const registry = createWorkspaceRegistry({
        tabNameKey: '__rpa_tab_name',
        extensionPaths: [],
        userDataRoot: '/tmp/rpa-browser-tests',
        runtime: runStepsDeps.runtime,
        recordingState,
        replayOptions: { clickDelayMs: 1, stepIntervalMs: 1, scroll: { minDelta: 1, maxDelta: 2, minSteps: 1, maxSteps: 2 } },
        navDedupeWindowMs: 1200,
        emit: options.emit,
        runStepsDeps,
        runnerConfig: getRunnerConfig(),
        portAllocator: createPortAllocator(20000),
        dispatchAction: runStepsDeps.dispatchAction,
        agentModelRuntime: options.agentModelRuntime,
        createBrowserSession: (sessionOptions): WorkspaceBrowserSession => {
            const session: WorkspaceBrowserSession = {
                workspaceName: sessionOptions.workspaceName,
                userDataDir: `/tmp/rpa-browser-tests/workspaces/${sessionOptions.workspaceName}`,
                wsPort: null,
                cdpPort: null,
                status: 'stopped',
                pageRegistry: testPageRegistry,
                start: async () => { session.status = 'running'; },
                stop: async () => { session.status = 'stopped'; },
                emit: () => undefined,
            };
            return session;
        },
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
