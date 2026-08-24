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
    const session = startCheckpointRecording(state, 'ws-1', {kind: 'recovery'});
    state.recordings.set(session.token, [clickStep('recovery')]);

    clearCheckpointRecording(state, 'ws-1');

    assert.equal(getCheckpointRecordingSession(state, 'ws-1'), null);
    assert.equal(state.recordings.has(session.token), false);
    assert.deepEqual(getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps.map((step) => step.id), ['ordinary']);
});

import {createRecordControl} from '../../../src/record/control';
import type {Action} from '../../../src/interface/actions/action_protocol';
import type {WorkflowArtifact, WorkflowCheckpoint, WorkflowEntityRules} from '../../../src/workflow';

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
    const entitySelection = {
        kind: 'recovery' as const,
        profileName: 'expired-session-rule',
        businessTag: 'auth.expired',
        entityKind: 'panel' as const,
    };
    const session = startCheckpointRecording(state, 'ws-1', entitySelection);
    state.recordings.set(session.token, [clickStep('recovery')]);
    state.recordingEnhancements.set(session.token, {
        recovery: {
            version: 1,
            resolveHint: {raw: {selector: '#close'}},
            resolvePolicy: {requireVisible: true},
        },
    });
    finishCheckpointRecording(state, 'ws-1');

    const errorRule: WorkflowEntityRules = {
        kind: 'entity_rules',
        name: 'expired-session-rule',
        page: {kind: 'panel'},
        match: {
            version: 2,
            rules: [{ruleId: 'expired-root', source: 'region', expect: 'unique', match: {kind: 'panel'}}],
        },
        annotation: {
            version: 2,
            bindings: [{
                ruleId: 'expired-root',
                businessTag: 'auth.expired',
                entityKey: 'authExpired',
                displayName: '登录失效提示',
                legacyCanvas: {
                    entities: [{
                        kind: 'panel',
                        businessTag: 'auth.expired',
                        annotations: [{
                            type: 'action',
                            businessKey: 'dismiss',
                            name: '关闭提示',
                            disposition: 'active',
                        }],
                    }],
                },
            }],
        },
    };
    const saved = new Map<string, WorkflowArtifact>([[errorRule.name, errorRule]]);
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
    assert.equal(saved.size, 2);
    const artifact = [...saved.values()].find((item): item is WorkflowCheckpoint => item.kind === 'checkpoint');
    assert.ok(artifact);
    assert.equal(artifact.checkpoint.name, '关闭登录提示');
    assert.deepEqual(artifact.checkpoint.trigger?.matchRules, [
        {entityExists: {query: '', kind: 'panel', businessTag: 'auth.expired'}},
        {errorCode: 'ERR_NOT_FOUND'},
        {stepName: 'browser.click'},
    ]);
    assert.deepEqual(artifact.checkpoint.body, {language: 'dsl', source: 'body.dsl'});
    assert.equal(artifact.checkpoint.content, undefined);
    assert.equal(artifact.bodyDsl, `use entity_rules "expired-session-rule" as entity\nuse resolves "${artifact.name}" as recorded\nclick recorded.step1`);
    assert.equal(Boolean(artifact.stepResolves.step1), true);
    assert.equal(getCheckpointRecordingSession(state, 'ws-1'), null);
    assert.deepEqual(getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps.map((step) => step.id), ['ordinary']);

    const retrySession = startCheckpointRecording(state, 'ws-1', entitySelection);
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
        /已有同名检查点/,
    );
    assert.equal(getCheckpointRecordingSession(state, 'ws-1')?.status, 'review');
    const brokenRule = structuredClone(errorRule);
    delete (brokenRule.annotation.bindings[0] as {entityKey?: string}).entityKey;
    saved.set(errorRule.name, brokenRule);
    const artifactCountBeforeLinkFailure = saved.size;
    await assert.rejects(
        async () => await control.handle({
            action: checkpointSaveAction({name: '链接失败不得保存', triggerKind: 'not_found'}),
            workspace: workspace as never,
            workspaceRegistry: {} as never,
        }),
        /不支持将录制步骤/,
    );
    assert.equal(saved.size, artifactCountBeforeLinkFailure);
    assert.equal(getCheckpointRecordingSession(state, 'ws-1')?.status, 'review');
    clearCheckpointRecording(state, 'ws-1');
});
