import test from 'node:test';
import assert from 'node:assert/strict';
import { replyAction, failedAction } from '../src/actions/action_protocol';
import { replayRecording } from '../src/record/replay';
import type { StepUnion } from '../src/runner/steps/types';
import { createRecordingState } from '../src/record/recording';
import { ACTION_TYPES } from '../src/actions/action_types';
import { createWorkspaceRegistry } from '../src/runtime/workspace_registry';
import { createWorkflowOnFs } from '../src/workflow';
import { handleRecordControlAction, setRecordControlServices } from '../src/record/control';

test('replyAction and failedAction keep action-to-action semantics with replyTo', () => {
    const request = { v: 1 as const, id: 'req-1', type: 'workspace.list', workspaceName: 'ws-1', traceId: 'trace-1', at: 123 };
    const ok = replyAction(request, { workspaces: [] });
    assert.equal(ok.type, 'workspace.list.result');
    assert.equal(ok.replyTo, request.id);
    const failed = failedAction(request, 'ERR_BAD_ARGS', 'bad input');
    assert.equal(failed.type, 'workspace.list.failed');
    assert.equal(failed.replyTo, request.id);
});

test('replayRecording emits step and progress events as stream', async () => {
    const step: StepUnion = { id: 'step-1', name: 'browser.scroll', args: { direction: 'down', amount: 120 }, meta: { source: 'record', ts: Date.now() } };
    const events: string[] = [];
    const result = await replayRecording({
        workspaceName: 'ws-1',
        initialTabName: 'tab-1',
        steps: [step],
        stopOnError: true,
        pageRegistry: { listTabs: async () => [{ tabName: 'tab-1', active: true }], resolveTabNameFromToken: () => 'tab-1', resolveTabNameFromRef: () => 'tab-1' },
        deps: {
            runtime: { ensureActivePage: async () => { throw new Error('should not be called'); } } as any,
            stepSinks: [],
            config: {} as any,
            pluginHost: { getExecutors: () => ({ 'browser.scroll': async (runStep: StepUnion) => ({ stepId: runStep.id, ok: true, data: { done: true } }) }) } as any,
        },
        onEvent: (event) => { events.push(event.type); },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(events, ['step.started', 'step.finished', 'progress']);
});

test('play.start returns play.started immediately and emits completion event from record control', async () => {
    const workspaceRegistry = createWorkspaceRegistry();
    const wsName = `ws-${Date.now()}`;
    const ws = workspaceRegistry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    const page = { url: () => 'https://example.com', goto: async () => undefined, isClosed: () => false } as any;
    ws.tabRegistry.createTab({ tabName: 'tab-1', page, url: 'https://example.com' });
    ws.tabRegistry.setActiveTab('tab-1');

    const recordingState = createRecordingState();
    recordingState.recordings.set('tab-1', [{ id: 's1', name: 'browser.scroll', args: { direction: 'down', amount: 1 }, meta: { source: 'record', ts: Date.now() } } as any]);
    recordingState.recordingManifests.set('tab-1', { recordingToken: 'tab-1', workspaceName: wsName, startedAt: Date.now(), tabs: [] });
    recordingState.workspaceLatestRecording.set(wsName, 'tab-1');

    const emitted: string[] = [];
    setRecordControlServices({
        recordingState,
        replayOptions: { clickDelayMs: 0, stepDelayMs: 0, scroll: { minDelta: 1, maxDelta: 2, minSteps: 1, maxSteps: 2 } },
        navDedupeWindowMs: 1000,
        emit: (action) => emitted.push(action.type),
    });

    const started = await handleRecordControlAction({
        action: { v: 1, id: 'play-req-1', type: ACTION_TYPES.PLAY_START, workspaceName: wsName, payload: {}, at: Date.now() },
        workspace: ws,
        workspaceRegistry,
    } as any);

    assert.equal(started.reply.type, ACTION_TYPES.PLAY_STARTED);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(emitted.includes(ACTION_TYPES.PLAY_COMPLETED) || emitted.includes(ACTION_TYPES.PLAY_FAILED), true);
});
