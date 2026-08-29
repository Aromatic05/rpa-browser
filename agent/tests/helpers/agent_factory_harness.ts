import type { Page } from 'playwright';
import { createExecutionBindings } from '../../src/automation/runtime/execution/bindings';
import { PageSnapshotSessionStore } from '../../src/automation/snapshot/session';
import { SnapshotProjectionBaselineStore } from '../../src/automation/runner/session';
import type { RunStepsDeps } from '../../src/automation/runner/run_steps_types';
import type { RunnerConfig } from '../../src/platform/config';
import type { WorkspaceAgentFactoryDeps } from '../../src/automation/runtime/workspace/agent';
import { createPortAllocator } from '../../src/automation/runtime/service/ports';
import type { AgentModelRuntime } from '../../src/agent/model/runtime';
import type { Action } from '../../src/interface/actions/action_protocol';
import {
    createFauxCore,
    fauxAssistantMessage,
} from '@earendil-works/pi-ai';

const stubPageRegistry = {
    createPage: async () => ({} as unknown as Page),
    bindPage: async () => null,
    awaitPageBinding: async () => ({} as unknown as Page),
    createPageBinding: async (_bindingName: string) => ({} as unknown as Page),
    touchBinding: () => true,
    listStaleBindings: () => [],
    closePage: async () => undefined,
    debugPageBindings: async () => ({
        bindingName: '',
        knownBindings: [],
        knownPagesSummary: [],
        pendingClaims: [],
    }),
    createPendingBindingClaim: () => undefined,
    claimPendingBinding: async () => false,
};

export const createFactoryRunStepsDeps = (config: RunnerConfig): RunStepsDeps => {
    const runtime = createExecutionBindings({ pageRegistry: stubPageRegistry });
    return {
        runtime,
        pageSession: new PageSnapshotSessionStore(),
        snapshotProjection: new SnapshotProjectionBaselineStore(),
        resolveWorkspace: () => {
            throw new Error('resolveWorkspace is not configured in agent factory harness');
        },
        dispatchAction: async (action: Action) => ({
            ...action,
            id: `${action.id}-reply`,
            type: `${action.type}.result`,
            replyTo: action.id,
        }),
        stepSinks: [],
        config,
        pluginHost: {
            getExecutors: () => ({}),
        },
    } as unknown as RunStepsDeps;
};

export const buildAgentFactoryDeps = (options: {
    workspaceName: string;
    runStepsDeps: RunStepsDeps;
    runnerConfig: RunnerConfig;
    portBegin?: number;
    portAllocator?: ReturnType<typeof createPortAllocator>;
}): WorkspaceAgentFactoryDeps => ({
    workspaceName: options.workspaceName,
    tabs: {} as never,
    runStepsDeps: options.runStepsDeps,
    runnerConfig: options.runnerConfig,
    portAllocator: options.portAllocator ?? createPortAllocator(options.portBegin ?? 26000),
    runWorkspaceExecution: async (_actionType, run) => await run(),
});

export type OfflineModelRuntime = {
    runtime: AgentModelRuntime;
    provider: string;
    model: string;
};

export const createFauxAgentModelRuntime = (
    provider = 'openai',
    model = 'gpt-4.1',
): OfflineModelRuntime => {
    const faux = createFauxCore({ provider, models: [{ id: model }] });
    faux.setResponses([fauxAssistantMessage('done')]);
    const runtime: AgentModelRuntime = {
        resolve: (requestedProvider, requestedModel) =>
            requestedProvider === provider && requestedModel === model
                ? {
                    model: faux.getModel() as never,
                    streamFn: faux.streamSimple,
                    getApiKey: () => 'test-key',
                }
                : null,
    };
    return { runtime, provider, model };
};