import test from 'node:test';
import assert from 'node:assert/strict';
import {
    clearCheckpointRecording,
    createRecordingState,
    finishCheckpointRecording,
    getCheckpointRecordingSession,
    getRecordingBundle,
    getWorkspaceUnsavedRecordingBundle,
    resetWorkspaceUnsavedRecording,
    startCheckpointRecording,
} from '../../../src/record/recording';
import type {StepUnion} from '../../../src/runner/steps/types';

const snapshotPort = {
    markDirty: () => undefined,
    capture: async () => ({}) as never,
    ensureFresh: async () => ({}) as never,
};

const clickStep = (id: string): StepUnion => ({
    id,
    name: 'browser.click',
    args: {selector: '#close'},
}) as StepUnion;

test('checkpoint recording uses an isolated buffer and restores the ordinary unsaved recording', () => {
    const state = createRecordingState({snapshotPort});
    const ordinaryToken = resetWorkspaceUnsavedRecording(state, 'ws-1');
    state.recordings.set(ordinaryToken, [clickStep('ordinary')]);

    const session = startCheckpointRecording(state, 'ws-1');
    assert.notEqual(session.token, ordinaryToken);
    assert.equal(getWorkspaceUnsavedRecordingBundle(state, 'ws-1').recordingToken, session.token);
    state.recordings.set(session.token, [clickStep('recovery')]);

    const finished = finishCheckpointRecording(state, 'ws-1');
    assert.equal(finished?.status, 'review');
    assert.equal(getWorkspaceUnsavedRecordingBundle(state, 'ws-1').recordingToken, ordinaryToken);
    assert.deepEqual(getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps.map((step) => step.id), ['ordinary']);
    assert.deepEqual(getRecordingBundle(state, session.token).steps.map((step) => step.id), ['recovery']);
});

test('canceling checkpoint recording removes only its isolated buffer', () => {
    const state = createRecordingState({snapshotPort});
    const ordinaryToken = resetWorkspaceUnsavedRecording(state, 'ws-1');
    state.recordings.set(ordinaryToken, [clickStep('ordinary')]);
    const session = startCheckpointRecording(state, 'ws-1');
    state.recordings.set(session.token, [clickStep('recovery')]);

    clearCheckpointRecording(state, 'ws-1');

    assert.equal(getCheckpointRecordingSession(state, 'ws-1'), null);
    assert.equal(state.recordings.has(session.token), false);
    assert.deepEqual(getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps.map((step) => step.id), ['ordinary']);
});

import {createRecordControl} from '../../../src/record/control';
import type {Action} from '../../../src/actions/action_protocol';
import type {WorkflowArtifact, WorkflowCheckpoint} from '../../../src/workflow';

const checkpointSaveAction = (payload: Record<string, unknown>): Action => ({
    v: 1,
    id: 'save-checkpoint',
    type: 'checkpoint.record.save',
    workspaceName: 'ws-1',
    payload,
});

test('checkpoint recording save creates a recovery artifact and leaves the ordinary recording untouched', async () => {
    const state = createRecordingState({snapshotPort});
    const ordinaryToken = resetWorkspaceUnsavedRecording(state, 'ws-1');
    state.recordings.set(ordinaryToken, [clickStep('ordinary')]);
    const session = startCheckpointRecording(state, 'ws-1');
    state.recordings.set(session.token, [clickStep('recovery')]);
    state.recordingEnhancements.set(session.token, {
        recovery: {
            version: 1,
            resolveHint: {raw: {selector: '#close'}},
            resolvePolicy: {requireVisible: true},
        },
    });
    finishCheckpointRecording(state, 'ws-1');

    const saved = new Map<string, WorkflowArtifact>();
    const workflow = {
        name: 'ws-1',
        save: (artifact: WorkflowArtifact) => {
            saved.set(artifact.name, structuredClone(artifact));
            return structuredClone(artifact);
        },
        get: (name: string) => structuredClone(saved.get(name) ?? null),
        list: (dummy: {kind: string}) => [...saved.values()]
            .filter((artifact) => artifact.kind === dummy.kind)
            .map((artifact) => ({
                kind: artifact.kind,
                name: artifact.name,
                title: artifact.name,
                summary: artifact.kind,
                createdAt: 1,
                updatedAt: 1,
                enabled: true,
            })),
        delete: () => false,
    };
    const workspace = {
        name: 'ws-1',
        workflow,
        state: 'idle',
        tabs: {
            getActiveTab: () => null,
            listTabs: () => [],
        },
    };
    const control = createRecordControl({
        recordingState: state,
        replayOptions: {} as never,
        navDedupeWindowMs: 100,
        runtime: {} as never,
        pageRegistry: {} as never,
        log: () => undefined,
    });

    const result = await control.handle({
        action: checkpointSaveAction({
            name: '关闭登录提示',
            triggerKind: 'not_found',
            operation: 'click',
            retryOriginal: true,
        }),
        workspace: workspace as never,
        workspaceRegistry: {} as never,
    });

    assert.equal(result.reply.type, 'checkpoint.record.save.result');
    assert.equal(saved.size, 1);
    const artifact = [...saved.values()][0] as WorkflowCheckpoint;
    assert.equal(artifact.kind, 'checkpoint');
    assert.equal(artifact.checkpoint.name, '关闭登录提示');
    assert.deepEqual(artifact.checkpoint.trigger?.matchRules, [
        {errorCode: 'ERR_NOT_FOUND'},
        {stepName: 'browser.click'},
    ]);
    assert.equal(artifact.checkpoint.content?.length, 1);
    assert.equal(((artifact.checkpoint.content?.[0] as StepUnion).args as {resolveId?: string}).resolveId, 'recorded-1');
    assert.equal(Boolean(artifact.stepResolves['recorded-1']), true);
    assert.equal(getCheckpointRecordingSession(state, 'ws-1'), null);
    assert.deepEqual(getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps.map((step) => step.id), ['ordinary']);

    const retrySession = startCheckpointRecording(state, 'ws-1');
    state.recordings.set(retrySession.token, [clickStep('retry')]);
    finishCheckpointRecording(state, 'ws-1');
    await assert.rejects(
        async () => await control.handle({
            action: checkpointSaveAction({name: '另一个名称', triggerKind: 'invalid'}),
            workspace: workspace as never,
            workspaceRegistry: {} as never,
        }),
        /触发条件无效/,
    );
    assert.equal(getCheckpointRecordingSession(state, 'ws-1')?.status, 'review');
    await assert.rejects(
        async () => await control.handle({
            action: checkpointSaveAction({name: '关闭登录提示', triggerKind: 'not_found'}),
            workspace: workspace as never,
            workspaceRegistry: {} as never,
        }),
        /已有同名恢复步骤/,
    );
    assert.equal(getCheckpointRecordingSession(state, 'ws-1')?.status, 'review');
    clearCheckpointRecording(state, 'ws-1');
});
