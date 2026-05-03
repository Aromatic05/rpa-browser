import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRuntimeLifecycle } from '../../src/runtime/browser/lifecycle';
import { createExecutionBindings } from '../../src/runtime/execution/bindings';
import { createWorkspaceRegistry } from '../../src/runtime/workspace_registry';
import { createRecordingState } from '../../src/record/recording';
import { createRecorderEventSinkHandler } from '../../src/record/sink';
import { createWorkflowOnFs, ensureWorkflowOnFs } from '../../src/workflow';

const createMockPage = (urlValue = 'https://example.com') => {
    const handlers = new Map<string, Function[]>();
    return {
        url: () => urlValue,
        context: () => ({}),
        on: (event: string, handler: Function) => {
            const list = handlers.get(event) || [];
            list.push(handler);
            handlers.set(event, list);
        },
    } as any;
};

const createEnv = () => {
    const recordingState = createRecordingState();
    const pageRegistry = { getPage: async () => createMockPage() } as any;
    const runtimeRegistry = createExecutionBindings({});
    const runStepsDeps = {
        runtime: runtimeRegistry,
        stepSinks: [],
        config: {} as any,
        pluginHost: { getExecutors: () => ({}) } as any,
    };
    const workspaceRegistry = createWorkspaceRegistry({
        pageRegistry,
        recordingState,
        replayOptions: { clickDelayMs: 1, stepDelayMs: 1, scroll: { minDelta: 1, maxDelta: 2, minSteps: 1, maxSteps: 2 } },
        navDedupeWindowMs: 1200,
        runStepsDeps: runStepsDeps as any,
        runnerConfig: { checkpointPolicy: { enabled: false, filePath: '.tmp', flushIntervalMs: 1000 } } as any,
    });
    return { recordingState, pageRegistry, runtimeRegistry, workspaceRegistry };
};

test('runtime lifecycle binds workspace/tab on page bound', () => {
    const env = createEnv();
    const emitted: string[] = [];
    const lifecycle = createRuntimeLifecycle({
        workspaceRegistry: env.workspaceRegistry,
        runtimeRegistry: env.runtimeRegistry,
        recordingState: env.recordingState,
        navDedupeWindowMs: 1200,
        pingTimeoutMs: 10,
        pingWatchdogIntervalMs: 10,
        emit: (action) => emitted.push(action.type),
        ensureWorkflow: ensureWorkflowOnFs,
        ensureRecorder: async () => undefined,
        setRecorderRuntimeEnabled: async () => undefined,
        getWorkspaceActiveRecordingToken: () => null,
        attachTabToRecordingManifest: () => undefined,
        cleanupRecording: () => undefined,
    });

    lifecycle.onPageBound(createMockPage('https://a.com'), 'tab-a');
    const ws = env.workspaceRegistry.getWorkspace('default');
    assert.ok(ws);
    assert.equal(ws?.tabRegistry.hasTab('tab-a'), true);
    assert.ok(env.runtimeRegistry.getBinding('default', 'tab-a'));
    assert.equal(emitted.includes('tab.bound'), true);
});

test('runtime lifecycle cleans recording on binding close', () => {
    const env = createEnv();
    env.recordingState.recordingEnabled.add('tab-close');

    const lifecycle = createRuntimeLifecycle({
        workspaceRegistry: env.workspaceRegistry,
        runtimeRegistry: env.runtimeRegistry,
        recordingState: env.recordingState,
        navDedupeWindowMs: 1200,
        pingTimeoutMs: 10,
        pingWatchdogIntervalMs: 10,
        emit: () => undefined,
        ensureWorkflow: ensureWorkflowOnFs,
        ensureRecorder: async () => undefined,
        setRecorderRuntimeEnabled: async () => undefined,
        getWorkspaceActiveRecordingToken: () => null,
        attachTabToRecordingManifest: () => undefined,
        cleanupRecording: (state, tabName) => {
            state.recordingEnabled.delete(tabName);
        },
    });

    lifecycle.onBindingClosed('tab-close');
    assert.equal(env.recordingState.recordingEnabled.has('tab-close'), false);
});

test('runtime lifecycle watchdog emits ping-timeout sync', async () => {
    const env = createEnv();
    const emitted: any[] = [];
    const closed: string[] = [];
    const ws = env.workspaceRegistry.createWorkspace('ws-ping', ensureWorkflowOnFs('ws-ping'));
    ws.tabRegistry.createTab({ tabName: 'tab-ping', url: 'about:blank' });

    const lifecycle = createRuntimeLifecycle({
        workspaceRegistry: env.workspaceRegistry,
        runtimeRegistry: env.runtimeRegistry,
        recordingState: env.recordingState,
        navDedupeWindowMs: 1200,
        pingTimeoutMs: 1,
        pingWatchdogIntervalMs: 10,
        emit: (action) => emitted.push(action),
        ensureWorkflow: ensureWorkflowOnFs,
        ensureRecorder: async () => undefined,
        setRecorderRuntimeEnabled: async () => undefined,
        getWorkspaceActiveRecordingToken: () => null,
        attachTabToRecordingManifest: () => undefined,
        cleanupRecording: () => undefined,
    });

    lifecycle.startWatchdog({
        listStaleBindings: () => [{ bindingName: 'tab-ping', lastSeenAt: Date.now() - 1000 }],
        closePage: async (name: string) => { closed.push(name); },
    } as any);

    await new Promise((resolve) => setTimeout(resolve, 25));
    lifecycle.stopWatchdog();

    assert.equal(closed.includes('tab-ping'), true);
    assert.equal(emitted.some((item) => item.type === 'workspace.sync'), true);
});

test('recorder sink handler ingests and emits record.event', async () => {
    const recordingState = createRecordingState();
    recordingState.recordingEnabled.add('tab-1');
    const emitted: string[] = [];

    const sink = createRecorderEventSinkHandler({
        recordingState,
        navDedupeWindowMs: 1200,
        emit: (action) => emitted.push(action.type),
        findWorkspaceNameByTabName: () => 'ws-1',
    });

    await sink({ tabName: 'tab-1', ts: Date.now(), type: 'click', selector: '#a' }, createMockPage(), 'tab-1');

    assert.equal(emitted.includes('record.event'), true);
    const steps = recordingState.recordings.get('tab-1') || [];
    assert.equal(steps.length >= 1, true);
});

test('static boundaries for main6 bootstrap', () => {
    const indexSource = fs.readFileSync(path.resolve(process.cwd(), 'src/index.ts'), 'utf8');
    const sinkSource = fs.readFileSync(path.resolve(process.cwd(), 'src/record/sink.ts'), 'utf8');
    const wsClientSource = fs.readFileSync(path.resolve(process.cwd(), 'src/actions/ws_client.ts'), 'utf8');
    const runtimeRegistrySource = fs.readFileSync(path.resolve(process.cwd(), 'src/runtime/execution/bindings.ts'), 'utf8');

    assert.equal(indexSource.includes('projectActionResult'), false);
    assert.equal(indexSource.includes('REPORT_STATE_SYNC_ACTIONS'), false);
    assert.equal(indexSource.includes('setInterval('), false);
    assert.equal(indexSource.includes('setRecorderEventSink(async'), false);
    assert.equal(indexSource.includes('runtime: null as unknown'), false);
    assert.equal(indexSource.includes('runtime: runtimeRegistry'), true);

    assert.equal(sinkSource.includes("actions/execute"), false);
    assert.equal(wsClientSource.includes('WORKSPACE_CHANGED'), true);
    assert.equal(wsClientSource.includes('WORKSPACE_SYNC'), true);
    assert.equal(runtimeRegistrySource.includes('workspaceRegistry'), false);
});
