import test from 'node:test';
import assert from 'node:assert/strict';
import { replyAction, failedAction } from '../src/actions/action_protocol';
import { replayRecording } from '../src/play/replay';
import type { StepUnion } from '../src/runner/steps/types';
import { recordingHandlers } from '../src/actions/recording';
import { createRecordingState } from '../src/record/recording';
import { ACTION_TYPES } from '../src/actions/action_types';

test('replyAction and failedAction keep action-to-action semantics with replyTo', () => {
    const request = {
        v: 1 as const,
        id: 'req-1',
        type: 'workspace.list',
        workspaceName: 'ws-1',
        traceId: 'trace-1',
        at: 123,
    };

    const ok = replyAction(request, { workspaces: [] });
    assert.equal(ok.type, 'workspace.list.result');
    assert.equal(ok.replyTo, request.id);
    assert.deepEqual(ok.payload, { workspaces: [] });
    assert.equal((ok as any).ok, undefined);

    const failed = failedAction(request, 'ERR_BAD_ARGS', 'bad input');
    assert.equal(failed.type, 'workspace.list.failed');
    assert.equal(failed.replyTo, request.id);
    assert.deepEqual(failed.payload, { code: 'ERR_BAD_ARGS', message: 'bad input', details: undefined });
    assert.equal((failed as any).ok, undefined);
});

test('replayRecording emits step and progress events as stream', async () => {
    const step: StepUnion = {
        id: 'step-1',
        name: 'browser.scroll',
        args: { direction: 'down', amount: 120 },
        meta: { source: 'record', ts: Date.now() },
    };
    const events: string[] = [];
    const result = await replayRecording({
        workspaceId: 'ws-1',
        initialTabId: 'tab-1',
        initialTabToken: 'token-1',
        steps: [step],
        stopOnError: true,
        pageRegistry: {
            listTabs: async () => [{ tabId: 'tab-1', active: true }],
            resolveTabIdFromToken: () => 'tab-1',
            resolveTabIdFromRef: () => 'tab-1',
        },
        deps: {
            runtime: {
                ensureActivePage: async () => {
                    throw new Error('should not be called');
                },
            } as any,
            stepSinks: [],
            config: {} as any,
            pluginHost: {
                getExecutors: () => ({
                    'browser.scroll': async (runStep: StepUnion) => ({
                        stepId: runStep.id,
                        ok: true,
                        data: { done: true },
                    }),
                }),
            } as any,
        },
        onEvent: (event) => {
            events.push(event.type);
        },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(events, ['step.started', 'step.finished', 'progress']);
});

test('play.start returns play.started immediately and emits completion event', async () => {
    const emitted: Array<{ type: string; payload?: any; replyTo?: string }> = [];
    const handler = recordingHandlers['play.start'];
    const ctx: any = {
        page: {
            url: () => 'https://example.com',
            goto: async () => undefined,
        },
        tabToken: 'token-src',
        pageRegistry: {
            resolveScopeFromToken: () => ({ workspaceId: 'ws-1', tabId: 'tab-1' }),
            listWorkspaces: () => [{ workspaceId: 'ws-1', activeTabId: 'tab-1', tabCount: 1 }],
            createTab: async () => 'tab-1',
            resolvePage: async () => ({
                url: () => 'https://example.com',
                goto: async () => undefined,
            }),
            setActiveWorkspace: () => undefined,
            setActiveTab: () => undefined,
            resolveTabToken: () => 'token-replay',
            listTabs: async () => [{ tabId: 'tab-1', active: true }],
        },
        log: () => undefined,
        recordingState: createRecordingState(),
        replayOptions: { clickDelayMs: 0, stepDelayMs: 0, scroll: { minDelta: 10, maxDelta: 20, minSteps: 1, maxSteps: 2 } },
        navDedupeWindowMs: 1000,
        emit: (action: any) => emitted.push(action),
    };
    const request = {
        v: 1 as const,
        id: 'play-req-1',
        type: ACTION_TYPES.PLAY_START,
        workspaceName: 'ws-1',
        payload: {},
        at: Date.now(),
    };

    const started = await handler(ctx, request);
    assert.equal(started.type, ACTION_TYPES.PLAY_STARTED);
    assert.equal(started.replyTo, request.id);
    assert.equal((started.payload as any)?.started, true);

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(emitted.some((action) => action.type === ACTION_TYPES.PLAY_COMPLETED), true);
});

test('record.stop resolves recording session by workspaceId even with mismatched tabToken', async () => {
    const handler = recordingHandlers[ACTION_TYPES.RECORD_STOP];
    const state = createRecordingState();
    state.recordingEnabled.add('token-a');
    state.recordingEnabled.add('token-b');
    state.recordings.set('token-a', []);
    state.recordings.set('token-b', []);
    state.recordingManifests.set('token-a', {
        recordingToken: 'token-a',
        workspaceId: 'ws-a',
        startedAt: 1,
        tabs: [],
    });
    state.recordingManifests.set('token-b', {
        recordingToken: 'token-b',
        workspaceId: 'ws-b',
        startedAt: 2,
        tabs: [],
    });
    state.workspaceLatestRecording.set('ws-a', 'token-a');
    state.workspaceLatestRecording.set('ws-b', 'token-b');

    const response = await handler(
        {
            page: { url: () => { throw new Error('no page in pageless mode'); } } as any,
            tabToken: 'unknown-tab-token',
            pageRegistry: {} as any,
            log: () => undefined,
            recordingState: state,
            replayOptions: {
                clickDelayMs: 0,
                stepDelayMs: 0,
                scroll: { minDelta: 10, maxDelta: 20, minSteps: 1, maxSteps: 2 },
            },
            navDedupeWindowMs: 1000,
        } as any,
        {
            v: 1,
            id: 'record-stop-1',
            type: ACTION_TYPES.RECORD_STOP,
            workspaceName: 'ws-b',
            payload: {},
            at: Date.now(),
        },
    );

    assert.equal(response.type, `${ACTION_TYPES.RECORD_STOP}.result`);
    assert.equal(state.recordingEnabled.has('token-b'), false);
    assert.equal(state.recordingEnabled.has('token-a'), true);
});

test('record.save writes workflow record artifacts to records dir', async () => {
    const handler = recordingHandlers[ACTION_TYPES.RECORD_SAVE];
    const state = createRecordingState();
    state.recordings.set('token-a', [
        {
            id: 'step-1',
            name: 'browser.click',
            args: { selector: '#submit' },
            meta: { source: 'record', ts: Date.now(), workspaceId: 'ws-1' },
        } as any,
    ]);
    const scene = `scene_${Date.now()}`;
    const response = await handler(
        {
            page: { url: () => 'https://example.com' } as any,
            tabToken: 'token-a',
            pageRegistry: {} as any,
            log: () => undefined,
            recordingState: state,
            replayOptions: { clickDelayMs: 0, stepDelayMs: 0, scroll: { minDelta: 10, maxDelta: 20, minSteps: 1, maxSteps: 2 } },
            navDedupeWindowMs: 1000,
        } as any,
        {
            v: 1,
            id: 'record-export-1',
            type: ACTION_TYPES.RECORD_SAVE,
            workspaceName: 'ws-1',
            payload: { scene },
            at: Date.now(),
        },
    );
    assert.equal(response.type, `${ACTION_TYPES.RECORD_SAVE}.result`);
    const payload = (response.payload || {}) as { recordsDir?: string; scene?: string; recordingName?: string };
    assert.equal(payload.scene, scene);
    assert.equal(typeof payload.recordsDir, 'string');
});

test('record.load loads saved artifact into workspace recording state', async () => {
    const saveHandler = recordingHandlers[ACTION_TYPES.RECORD_SAVE];
    const loadHandler = recordingHandlers[ACTION_TYPES.RECORD_LOAD];
    const sourceState = createRecordingState();
    sourceState.recordings.set('token-src', [
        {
            id: 'step-1',
            name: 'browser.fill',
            args: { selector: '#name', value: 'Alice' },
            meta: { source: 'record', ts: Date.now(), workspaceId: 'ws-src' },
        } as any,
    ]);
    const scene = `scene_${Date.now()}`;
    const saved = await saveHandler(
        {
            page: { url: () => 'https://example.com' } as any,
            tabToken: 'token-src',
            pageRegistry: {} as any,
            log: () => undefined,
            recordingState: sourceState,
            replayOptions: { clickDelayMs: 0, stepDelayMs: 0, scroll: { minDelta: 10, maxDelta: 20, minSteps: 1, maxSteps: 2 } },
            navDedupeWindowMs: 1000,
        } as any,
        {
            v: 1,
            id: 'record-export-2',
            type: ACTION_TYPES.RECORD_SAVE,
            workspaceName: 'ws-src',
            payload: { scene },
            at: Date.now(),
        },
    );
    const savedPayload = (saved.payload || {}) as { recordingName?: string };
    const recordingName = savedPayload.recordingName || '';
    const targetState = createRecordingState();
    const imported = await loadHandler(
        {
            page: { url: () => 'https://example.com' } as any,
            tabToken: 'token-target',
            pageRegistry: {} as any,
            log: () => undefined,
            recordingState: targetState,
            replayOptions: { clickDelayMs: 0, stepDelayMs: 0, scroll: { minDelta: 10, maxDelta: 20, minSteps: 1, maxSteps: 2 } },
            navDedupeWindowMs: 1000,
        } as any,
        {
            v: 1,
            id: 'record-import-1',
            type: ACTION_TYPES.RECORD_LOAD,
            workspaceName: 'ws-target',
            payload: { scene, recordingName },
            at: Date.now(),
        },
    );
    assert.equal(imported.type, `${ACTION_TYPES.RECORD_LOAD}.result`);
    const importedToken = targetState.workspaceLatestRecording.get('ws-target');
    assert.equal(typeof importedToken, 'string');
    assert.equal((targetState.recordings.get(importedToken || '') || []).length, 1);
});
